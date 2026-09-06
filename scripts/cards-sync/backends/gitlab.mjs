import fs from "node:fs/promises";
import path from "node:path";
import {
  parseOnlyFilter,
  parseCardFile,
  buildEdges,
  buildIssueTitle,
  buildRemoteDescriptionFromCard,
  normalizeText,
  resolveMappedStatus,
  parseCardIdFromIssueBody,
  parseSourceFileFromIssueBody,
  parseSyncMetadataFromDescription,
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
  applyKitSampleFilter,
  applyReverseCardFileUpdate,
  countReverseWrite,
} from "../sync.mjs";

function gitlabCardSearchTerm(card) {
  return `CARD_ID: ${card.cardId}`;
}

/**
 * GitLab issues only have open/closed. Map Done-like statuses to close;
 * otherwise reopen + optional status label.
 */
export function resolveGitLabStatusAction(statusMap, hyperionStatus) {
  const mapped = resolveMappedStatus(statusMap, hyperionStatus);
  if (!mapped) return null;
  const n = normalizeText(mapped);
  const closeNames = new Set([
    "closed",
    "close",
    "done",
    "resolved",
    "completo",
    "concluido",
    "concluído",
    "fechado",
  ]);
  if (closeNames.has(n)) {
    return { state_event: "close", label: mapped, mapped };
  }
  return { state_event: "reopen", label: mapped, mapped };
}

/**
 * Parent-child hierarchy: plain GitLab Issues have no native Epic-style
 * hierarchy on the Free tier, so the closest real equivalent is an issue
 * link (relates_to) between child and parent, mirroring the
 * buildEdges()-driven linking already done for Jira.
 *
 * Standalone + exported (not a closure over runForwardSyncGitLab's local
 * projectId/gitlabRequest) specifically so it's unit-testable with a stub
 * request function.
 *
 * @param {(endpoint: string, method?: string, body?: unknown) => Promise<unknown>} gitlabRequest
 */
export async function gitlabLinkIssues(gitlabRequest, projectId, childIid, parentIid) {
  await gitlabRequest(
    `/api/v4/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(childIid)}/links`,
    "POST",
    {
      target_project_id: projectId,
      target_issue_iid: parentIid,
      link_type: "relates_to",
    }
  );
}

export async function runForwardSyncGitLab(repoConfig, management) {
  if (!management.gitlabProjectId || !management.gitlabToken) {
    throw new Error("GitLab backend requires GITLAB_PROJECT_ID and GITLAB_TOKEN (env or config).");
  }

  const projectId = management.gitlabProjectId;
  const token = management.gitlabToken;
  const gitlabBase = management.gitlabUrl || "https://gitlab.com";
  const statusMap = management.statusMap || {};

  const headers = {
    "PRIVATE-TOKEN": token,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function gitlabRequest(endpoint, method = "GET", body = undefined) {
    const url = `${gitlabBase.replace(/\/+$/, "")}${endpoint}`;
    const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`GitLab request failed (${response.status} ${response.statusText}): ${JSON.stringify(payload)}`);
    }
    return payload;
  }

  async function gitlabFindIssueByCardId(card) {
    const term = gitlabCardSearchTerm(card);
    const data = await gitlabRequest(
      `/api/v4/projects/${encodeURIComponent(projectId)}/issues?search=${encodeURIComponent(term)}&state=all&per_page=20`,
      "GET"
    );
    const list = Array.isArray(data) ? data : [];
    const exact = list.find((issue) => parseCardIdFromIssueBody(issue?.description || "") === card.cardId);
    return exact || null;
  }

  async function gitlabCreateIssue(card) {
    const title = buildIssueTitle(card);
    const description = buildRemoteDescriptionFromCard(card);
    const labels = card.categories || [];
    const data = await gitlabRequest(`/api/v4/projects/${encodeURIComponent(projectId)}/issues`, "POST", {
      title,
      description,
      labels,
    });
    return data;
  }

  async function gitlabUpdateIssue(iid, card) {
    const title = buildIssueTitle(card);
    const description = buildRemoteDescriptionFromCard(card);
    const labels = card.categories || [];
    await gitlabRequest(`/api/v4/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(iid)}`, "PUT", {
      title,
      description,
      labels,
    });
  }


  async function gitlabApplyStatus(iid, card) {
    const action = resolveGitLabStatusAction(statusMap, card.status);
    if (!action) return { applied: false, reason: "no_status" };
    const existingLabels = Array.isArray(card.categories) ? [...card.categories] : [];
    const statusLabel = `status:${action.label}`;
    if (!existingLabels.some((l) => normalizeText(l) === normalizeText(statusLabel))) {
      existingLabels.push(statusLabel);
    }
    try {
      await gitlabRequest(`/api/v4/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(iid)}`, "PUT", {
        state_event: action.state_event,
        labels: existingLabels,
      });
      return { applied: true, gitlabStateEvent: action.state_event, mapped: action.mapped };
    } catch (error) {
      return { applied: false, reason: error.message, mapped: action.mapped };
    }
  }

  const allMd = await listMarkdownFiles(cardsRoot);
  const cards = [];
  for (const file of allMd) {
    const relative = path.relative(workspaceRoot, file).replace(/\\/g, "/");
    const content = await fs.readFile(file, "utf8");
    const card = parseCardFile(content, relative);
    if (card) cards.push(card);
  }

  if (!cards.length) {
    log("No valid cards found for GitLab mode.");
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
  log(`Parent-child links: ${edges.length}`);

  const actions = [];
  const issueIidByCardId = new Map();
  for (const card of syncableCards) {
    const existing = await gitlabFindIssueByCardId(card);
    if (dryRun) {
      actions.push({
        action: existing ? "UPDATE" : "CREATE",
        cardId: card.cardId,
        gitlabIssueIid: existing?.iid || null,
        status: card.status || null,
      });
      continue;
    }
    let iid = existing?.iid;
    if (existing) {
      await gitlabUpdateIssue(existing.iid, card);
      actions.push({ action: "UPDATED", cardId: card.cardId, gitlabIssueIid: existing.iid });
    } else {
      const created = await gitlabCreateIssue(card);
      iid = created?.iid;
      actions.push({ action: "CREATED", cardId: card.cardId, gitlabIssueIid: iid || null });
    }
    if (iid) issueIidByCardId.set(card.cardId, iid);
    if (iid && card.status) {
      const st = await gitlabApplyStatus(iid, card);
      actions.push({
        action: st.applied ? "STATUS_SET" : "STATUS_SKIPPED",
        cardId: card.cardId,
        gitlabIssueIid: iid,
        status: card.status,
        ...st,
      });
    }
  }

  if (!dryRun) {
    for (const edge of edges) {
      const parentIid = issueIidByCardId.get(edge.parentCardId);
      const childIid = issueIidByCardId.get(edge.childCardId);
      if (!parentIid || !childIid) continue;
      try {
        await gitlabLinkIssues(gitlabRequest, projectId, childIid, parentIid);
        actions.push({ action: "LINKED", parent: parentIid, child: childIid });
      } catch (error) {
        actions.push({ action: "LINK_FAILED", parent: parentIid, child: childIid, reason: error.message });
      }
    }
  }

  log("");
  log("=== GITLAB SYNC COMPLETE ===");
  for (const a of actions) log(JSON.stringify(a));
}

export async function runReverseSyncGitLab(repoConfig, management) {
  if (!management.gitlabProjectId || !management.gitlabToken) {
    throw new Error("GitLab backend requires GITLAB_PROJECT_ID and GITLAB_TOKEN (env or config).");
  }

  const statusMap = management.statusMap || {};

  log(`Backend: gitlab`);
  log(`Dry-run: ${dryRun ? "yes" : "no"}`);
  log("Direction: reverse (GitLab -> Markdown)");

  const projectId = management.gitlabProjectId;
  const gitlabBase = String(management.gitlabUrl || "https://gitlab.com").replace(/\/+$/, "");
  const headers = {
    "PRIVATE-TOKEN": management.gitlabToken,
    Accept: "application/json",
  };

  async function gitlabRequest(endpoint) {
    const response = await fetch(`${gitlabBase}${endpoint}`, { headers });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`GitLab request failed (${response.status}): ${JSON.stringify(payload)}`);
    }
    return payload;
  }

  const issues = [];
  let page = 1;
  while (page <= 10) {
    const batch = await gitlabRequest(
      `/api/v4/projects/${encodeURIComponent(projectId)}/issues?search=${encodeURIComponent("CARD_ID:")}&state=all&per_page=50&page=${page}`
    );
    if (!Array.isArray(batch) || !batch.length) break;
    issues.push(
      ...batch.filter((i) => Boolean(parseCardIdFromIssueBody(String(i?.description || ""))))
    );
    if (batch.length < 50) break;
    page += 1;
  }

  if (!issues.length) {
    log("No GitLab issues with CARD_ID found.");
    return;
  }

  log(`GitLab issues found: ${issues.length}`);

  let written = 0;
  let skipped = 0;
  let skippedSamples = 0;
  let unchanged = 0;

  for (const issue of issues) {
    const description = issue.description || "";
    const syncMeta = parseSyncMetadataFromDescription(description);
    const sourceFile = syncMeta?.meta?.SOURCE_FILE || parseSourceFileFromIssueBody(description);
    const cardId = syncMeta?.meta?.CARD_ID || parseCardIdFromIssueBody(description);
    if (!sourceFile) continue;

    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    const statusLabel = labels.find((l) => String(l).toLowerCase().startsWith("status:"));
    const remoteStatus = statusLabel
      ? String(statusLabel).slice("status:".length)
      : issue.state === "closed"
        ? "Done"
        : issue.state === "opened"
          ? "In Progress"
          : null;
    const hyperionStatus = resolveHyperionStatusFromRemote(remoteStatus, statusMap, repoConfig);

    const converted = remoteIssueToCardMarkdown({
      title: issue.title,
      description,
      labels: labels.filter((l) => !String(l).toLowerCase().startsWith("status:")),
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
      logLabel: ` (GitLab !${issue.iid})`,
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
  if (!dryRun) log(`GitLab reverse sync wrote: ${written} file(s)`);
  if (skipped > 0) log(`Skipped: ${skipped} issue(s).`);
}
