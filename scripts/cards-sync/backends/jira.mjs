import fs from "node:fs/promises";
import path from "node:path";
import {
  parseOnlyFilter,
  parseCardFile,
  buildEdges,
  buildIssueTitle,
  buildJiraDescription,
  normalizeText,
  buildOptionCandidates,
  resolveMappedStatus,
  parseCardIdFromIssueBody,
  parseSourceFileFromIssueBody,
  parseSyncMetadataFromDescription,
  pickCanonicalIssueForCardId,
  remoteIssueToCardMarkdown,
  resolveHyperionStatusFromRemote,
  remoteBoardSyncAt,
} from "../lib.mjs";
import {
  log,
  dryRun,
  cardsRoot,
  workspaceRoot,
  cardsPrefix,
  listMarkdownFiles,
  logNoCardFilesFound,
  applyKitSampleFilter,
  printDryRunTable,
  applyReverseCardFileUpdate,
  countReverseWrite,
} from "../sync.mjs";

function encodeJiraAuth(email, tokenValue) {
  return Buffer.from(`${email}:${tokenValue}`).toString("base64");
}

export async function jiraRequest(management, endpoint, method = "GET", body = null) {
  const baseUrl = String(management.jiraUrl || "").replace(/\/+$/, "");
  const url = `${baseUrl}${endpoint}`;
  const headers = {
    Authorization: `Basic ${encodeJiraAuth(management.jiraEmail, management.jiraApiToken)}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payloadText = await response.text();
  let payload = null;
  try {
    payload = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    payload = { raw: payloadText };
  }
  if (!response.ok) {
    const error = new Error(`Jira request failed (${response.status} ${response.statusText}): ${JSON.stringify(payload)}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const SEARCH_PAGE_SIZE = 100;

function cardIdJql(projectKey) {
  return `project = "${projectKey}" AND description ~ "\\"CARD_ID:\\"" ORDER BY updated DESC`;
}

/**
 * Every issue matching `jql`. Jira Cloud only serves /search/jql (paged by
 * nextPageToken); Jira Data Center only has /search (paged by startAt), so
 * that one is used when /search/jql answers 404 or 405 on the first page.
 */
export async function jiraSearchAll(management, jql, fields) {
  const query = `jql=${encodeURIComponent(jql)}&maxResults=${SEARCH_PAGE_SIZE}&fields=${fields.join(",")}`;
  const issues = [];
  let token = null;
  let cloudError;
  try {
    while (true) {
      const tokenParam = token ? `&nextPageToken=${encodeURIComponent(token)}` : "";
      const page = await jiraRequest(management, `/rest/api/2/search/jql?${query}${tokenParam}`);
      const batch = page.issues || [];
      issues.push(...batch);
      token = page.nextPageToken;
      if (!token || page.isLast || !batch.length) return issues;
    }
  } catch (error) {
    if (![404, 405].includes(error.status) || issues.length) throw error;
    cloudError = error;
  }

  let startAt = 0;
  try {
    while (true) {
      const page = await jiraRequest(management, `/rest/api/2/search?${query}&startAt=${startAt}`);
      const batch = page.issues || [];
      issues.push(...batch);
      startAt = Number(page.startAt ?? startAt) + batch.length;
      if (!batch.length || startAt >= Number(page.total ?? issues.length)) return issues;
    }
  } catch (error) {
    const both = new Error(
      `Jira search failed on /rest/api/2/search/jql (${cloudError.message}) and on the /rest/api/2/search fallback (${error.message})`
    );
    both.status = error.status;
    throw both;
  }
}

/** pickCanonicalIssueForCardId compares GitHub-shaped { state, number }; a Jira key's number is its suffix. */
function jiraCanonicalCandidate(issue) {
  const done = issue.fields?.status?.statusCategory?.key === "done";
  return { issue, state: done ? "CLOSED" : "OPEN", number: Number(String(issue.key || "").split("-").pop()) };
}

/** When several issues carry the same CARD_ID, the open one with the lowest number wins, like the other backends. */
async function jiraIndexIssuesByCardId(management) {
  const issues = await jiraSearchAll(management, cardIdJql(management.jiraProjectKey), [
    "summary",
    "labels",
    "description",
    "status",
  ]);
  const byCardId = new Map();
  for (const issue of issues) {
    const cardId = parseCardIdFromIssueBody(issue.fields?.description || "");
    if (cardId) byCardId.set(cardId, pickCanonicalIssueForCardId(byCardId.get(cardId), jiraCanonicalCandidate(issue)));
  }
  return new Map([...byCardId].map(([cardId, picked]) => [cardId, picked.issue]));
}

async function jiraCreateIssue(management, projectKey, card) {
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { name: management.jiraIssueType || "Task" },
      summary: buildIssueTitle(card),
      description: buildJiraDescription(card),
      labels: card.categories || [],
    },
  };
  return jiraRequest(management, "/rest/api/2/issue", "POST", body);
}

async function jiraUpdateIssue(management, issueKey, card) {
  const body = {
    fields: {
      summary: buildIssueTitle(card),
      description: buildJiraDescription(card),
      labels: card.categories || [],
    },
  };
  await jiraRequest(management, `/rest/api/2/issue/${issueKey}`, "PUT", body);
}

/** @param {string|string[]} targetStatus a status name, or the candidate names to try in order */
export function pickJiraTransition(transitions, targetStatus, repoConfig = {}) {
  if (!targetStatus || !Array.isArray(transitions)) return null;

  const candidates = Array.isArray(targetStatus) ? targetStatus : buildOptionCandidates("status", targetStatus, repoConfig);

  for (const candidate of candidates) {
    const norm = normalizeText(candidate);
    const match = transitions.find((transition) => {
      const toName = normalizeText(transition.to?.name || "");
      const transitionName = normalizeText(transition.name || "");
      return toName === norm || transitionName === norm;
    });
    if (match) return match;
  }

  return null;
}

async function jiraGetTransitions(management, issueKey) {
  const data = await jiraRequest(management, `/rest/api/2/issue/${issueKey}/transitions`, "GET");
  return data.transitions || [];
}

/**
 * Moves the issue to the statusMap target for `cardStatus`, or to `cardStatus` itself
 * when the workflow has no transition to the mapped name. `currentStatus` (unknown for
 * an issue created in this run) skips the transition when the issue is already there.
 */
async function jiraApplyStatusTransition(management, issueKey, cardStatus, { statusMap, repoConfig, currentStatus = null }) {
  const targetStatus = resolveMappedStatus(statusMap, cardStatus);
  if (!targetStatus) return { applied: false, reason: "no_status" };

  const preferred = buildOptionCandidates("status", targetStatus, repoConfig);
  const fallback = targetStatus === cardStatus ? [] : buildOptionCandidates("status", cardStatus, repoConfig);
  const isCurrent = (candidates) =>
    Boolean(currentStatus) && candidates.some((c) => normalizeText(c) === normalizeText(currentStatus));
  const unchanged = { applied: false, reason: "already_in_status", targetStatus, current: currentStatus };
  if (isCurrent(preferred)) return unchanged;

  const transitions = await jiraGetTransitions(management, issueKey);
  let match = pickJiraTransition(transitions, preferred);
  if (!match) {
    if (isCurrent(fallback)) return unchanged;
    match = pickJiraTransition(transitions, fallback);
  }

  if (!match) {
    return {
      applied: false,
      reason: "no_matching_transition",
      targetStatus,
      available: transitions.map((t) => t.to?.name || t.name).filter(Boolean),
    };
  }

  await jiraRequest(management, `/rest/api/2/issue/${issueKey}/transitions`, "POST", {
    transition: { id: match.id },
  });

  return { applied: true, transition: match.name, to: match.to?.name || null };
}

/**
 * Standalone + exported (not a closure over runForwardSyncJira's
 * `management`) specifically so it's unit-testable with a stub request
 * function — same shape as azureLinkWorkItems/gitlabLinkIssues/linearSetParent.
 *
 * @param {(endpoint: string, method?: string, body?: unknown) => Promise<unknown>} jiraRequestFn
 */
export async function jiraLinkIssues(jiraRequestFn, inwardKey, outwardKey) {
  const body = {
    type: { name: "Relates" },
    inwardIssue: { key: inwardKey },
    outwardIssue: { key: outwardKey },
  };
  await jiraRequestFn("/rest/api/2/issueLink", "POST", body);
}

export async function runForwardSyncJira(repoConfig, management) {
  if (!management.jiraUrl || !management.jiraProjectKey || !management.jiraEmail || !management.jiraApiToken) {
    throw new Error(
      "Jira backend requires JIRA_URL, JIRA_PROJECT_KEY, JIRA_EMAIL, and JIRA_API_TOKEN (env or config)."
    );
  }

  const allMd = await listMarkdownFiles(cardsRoot);
  if (!allMd.length) {
    await logNoCardFilesFound(cardsRoot);
    return;
  }

  const cards = [];
  for (const file of allMd) {
    const relative = path.relative(workspaceRoot, file).replace(/\\/g, "/");
    const content = await fs.readFile(file, "utf8");
    const card = parseCardFile(content, relative);
    if (card) cards.push(card);
    else log(`SKIP (no frontmatter/card_id): ${relative}`);
  }

  if (!cards.length) {
    log("No valid cards found (all files missing YAML frontmatter with card_id).");
    return;
  }

  const onlyIds = parseOnlyFilter();
  const syncableCards = applyKitSampleFilter(cards, onlyIds);
  if (!syncableCards.length) {
    log(
      `No cards to sync. Add project cards under ${cardsPrefix}/{epics,features,stories,tasks}/ — kit samples in _examples/ and *.template.md are never synced.`
    );
    return;
  }

  const edges = buildEdges(syncableCards);
  log(`Valid cards: ${syncableCards.length}`);
  log(`Parent-child links: ${edges.length}`);

  if (dryRun) {
    printDryRunTable(syncableCards, edges);
    log("Dry-run in Jira mode: no remote changes applied.");
    return;
  }

  const actions = [];
  const issueByCardId = new Map();
  const statusMap = management.statusMap || {};
  const remoteByCardId = await jiraIndexIssuesByCardId(management);

  for (const card of syncableCards) {
    const existing = remoteByCardId.get(card.cardId);
    let issueKey;
    if (existing) {
      await jiraUpdateIssue(management, existing.key, card);
      issueKey = existing.key;
      issueByCardId.set(card.cardId, issueKey);
      actions.push({ action: "UPDATED", cardId: card.cardId, issueKey });
    } else {
      const created = await jiraCreateIssue(management, management.jiraProjectKey, card);
      issueKey = created?.key || null;
      if (issueKey) issueByCardId.set(card.cardId, issueKey);
      actions.push({ action: "CREATED", cardId: card.cardId, issueKey });
    }

    if (issueKey && card.status) {
      const transitionResult = await jiraApplyStatusTransition(management, issueKey, card.status, {
        statusMap,
        repoConfig,
        currentStatus: existing?.fields?.status?.name || null,
      });
      const statusAction = transitionResult.applied
        ? "STATUS_TRANSITIONED"
        : transitionResult.reason === "already_in_status"
          ? "STATUS_UNCHANGED"
          : "STATUS_SKIPPED";
      actions.push({
        action: statusAction,
        cardId: card.cardId,
        issueKey,
        status: card.status,
        ...transitionResult,
      });
    }
  }

  for (const edge of edges) {
    const parentKey = issueByCardId.get(edge.parentCardId);
    const childKey = issueByCardId.get(edge.childCardId);
    if (!parentKey || !childKey) continue;
    try {
      await jiraLinkIssues((endpoint, method, body) => jiraRequest(management, endpoint, method, body), parentKey, childKey);
      actions.push({ action: "LINKED", parent: parentKey, child: childKey });
    } catch (error) {
      actions.push({ action: "LINK_FAILED", parent: parentKey, child: childKey, reason: error.message });
    }
  }

  log("");
  log("=== JIRA SYNC COMPLETE ===");
  for (const action of actions) {
    log(JSON.stringify(action));
  }
}

export function jiraIssueToCardMarkdown(issue) {
  return remoteIssueToCardMarkdown({
    title: issue?.fields?.summary,
    description: issue?.fields?.description || "",
    labels: issue?.fields?.labels,
  });
}

export async function runReverseSyncJira(repoConfig, management) {
  if (!management.jiraUrl || !management.jiraProjectKey || !management.jiraEmail || !management.jiraApiToken) {
    throw new Error(
      "Jira backend requires JIRA_URL, JIRA_PROJECT_KEY, JIRA_EMAIL, and JIRA_API_TOKEN (env or config)."
    );
  }

  const statusMap = management.statusMap || {};

  log(`Backend: jira`);
  log(`Dry-run: ${dryRun ? "yes" : "no"}`);
  log("Direction: reverse (Jira -> Markdown)");

  const issues = await jiraSearchAll(management, cardIdJql(management.jiraProjectKey), [
    "summary",
    "description",
    "labels",
    "status",
    "updated",
  ]);

  if (!issues.length) {
    log("No Jira issues with CARD_ID found.");
    return;
  }

  log(`Jira issues found: ${issues.length}`);

  let written = 0;
  let skipped = 0;
  let skippedSamples = 0;
  let unchanged = 0;

  for (const issue of issues) {
    const description = issue?.fields?.description || "";
    const syncMeta = parseSyncMetadataFromDescription(description);
    const sourceFile = syncMeta?.meta?.SOURCE_FILE || parseSourceFileFromIssueBody(description);
    const cardId = syncMeta?.meta?.CARD_ID || parseCardIdFromIssueBody(description);
    if (!sourceFile) continue;

    const remoteStatus = issue?.fields?.status?.name || null;
    const hyperionStatus = resolveHyperionStatusFromRemote(remoteStatus, statusMap, repoConfig);

    const converted = remoteIssueToCardMarkdown({
      title: issue.fields.summary,
      description,
      labels: issue.fields.labels || [],
      statusOverride: hyperionStatus,
    });

    const result = await applyReverseCardFileUpdate({
      sourceFile,
      cardId,
      remoteUpdates: {
        ...(hyperionStatus ? { status: hyperionStatus } : {}),
        ...(remoteBoardSyncAt(issue) ? { board_sync_at: remoteBoardSyncAt(issue) } : {}),
      },
      converted,
      logLabel: ` (Jira ${issue.key})`,
    });

    if (result.kind === "skipped_sample") {
      skippedSamples += 1;
      continue;
    }
    if (result.kind === "unchanged") unchanged += 1;
    else if (result.kind === "skipped") skipped += 1;
    else written += countReverseWrite(result);
  }

  if (skippedSamples > 0) log(`Skipped ${skippedSamples} kit sample issue(s).`);
  if (unchanged > 0) log(`Unchanged: ${unchanged} card(s).`);
  if (!dryRun) log(`Jira reverse sync wrote: ${written} file(s)`);
  if (skipped > 0) log(`Skipped: ${skipped} issue(s).`);
}
