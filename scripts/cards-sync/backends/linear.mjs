import fs from "node:fs/promises";
import path from "node:path";
import {
  parseOnlyFilter,
  parseCardFile,
  buildEdges,
  buildIssueTitle,
  buildRemoteDescriptionFromCard,
  normalizeText,
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

// eslint-disable-next-line no-unused-vars -- kept identical to the pre-extraction sync.mjs (unused there too)
function linearCardSearchMarker(card) {
  return `CARD_ID: ${card.cardId}`;
}

export async function runForwardSyncLinear(repoConfig, management) {
  if (!management.linearTeamId || !management.linearApiToken) {
    throw new Error("Linear backend requires LINEAR_TEAM_ID and LINEAR_API_TOKEN (env or config).");
  }

  const endpoint = "https://api.linear.app/graphql";
  const teamId = management.linearTeamId;
  const apiToken = management.linearApiToken;
  const statusMap = management.statusMap || {};

  async function linearGraphql(query, variables = {}) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) {
      const details = JSON.stringify(payload.errors || payload, null, 2);
      throw new Error(`Linear GraphQL failed: ${details}`);
    }
    return payload.data;
  }

  const searchMarker = (cardId) => `CARD_ID: ${cardId}`;

  async function linearFindIssueIdByCardId(cardId) {
    const marker = searchMarker(cardId);
    let cursor = null;

    while (true) {
      const query = `query($teamId: String!, $marker: String!, $after: String) {
        team(id: $teamId) {
          issues(first: 50, after: $after, filter: { description: { containsIgnoreCase: $marker } }) {
            pageInfo { hasNextPage endCursor }
            nodes { id description }
          }
        }
      }`;

      const data = await linearGraphql(query, { teamId, marker, after: cursor });
      const conn = data?.team?.issues;
      for (const node of conn?.nodes || []) {
        const parsedId = parseCardIdFromIssueBody(node.description || "");
        if (parsedId === cardId) return node.id;
      }

      if (!conn?.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }

    return null;
  }

  async function linearCreateIssue(card) {
    const query = `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id title }
      }
    }`;

    const input = {
      teamId,
      title: buildIssueTitle(card),
      description: buildRemoteDescriptionFromCard(card),
    };

    const data = await linearGraphql(query, { input });
    return data?.issueCreate?.issue?.id || null;
  }

  async function linearUpdateIssue(issueId, card) {
    const query = `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id title }
      }
    }`;

    const input = {
      title: buildIssueTitle(card),
      description: buildRemoteDescriptionFromCard(card),
    };

    await linearGraphql(query, { id: issueId, input });
  }

  // Parent-child hierarchy: Linear has real sub-issues, unlike GitLab Free —
  // setting parentId on the child is a first-class relationship, not just a
  // link, mirroring the buildEdges()-driven linking already done for Jira.
  async function linearSetParent(childIssueId, parentIssueId) {
    const query = `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { id parent { id } } }
    }`;
    await linearGraphql(query, { id: childIssueId, input: { parentId: parentIssueId } });
  }

  let linearStatesCache = null;
  async function linearGetTeamStates() {
    if (linearStatesCache) return linearStatesCache;
    const query = `query($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type } }
      }
    }`;
    const data = await linearGraphql(query, { teamId });
    linearStatesCache = data?.team?.states?.nodes || [];
    return linearStatesCache;
  }

  function pickLinearState(states, hyperionStatus) {
    if (!hyperionStatus || !states?.length) return null;
    const mapped = statusMap[hyperionStatus] || hyperionStatus;
    const target = normalizeText(mapped);
    let best = null;
    for (const state of states) {
      const name = normalizeText(state.name);
      if (name === target) return state;
      if (name.includes(target) || target.includes(name)) best = best || state;
    }
    for (const state of states) {
      if (normalizeText(state.name) === normalizeText(hyperionStatus)) return state;
    }
    return best;
  }

  async function linearApplyStatus(issueId, hyperionStatus) {
    if (!hyperionStatus) return { applied: false, reason: "no_status" };
    const states = await linearGetTeamStates();
    const picked = pickLinearState(states, hyperionStatus);
    if (!picked) return { applied: false, reason: "no_matching_state", hyperionStatus };
    const query = `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { id state { name } } }
    }`;
    await linearGraphql(query, { id: issueId, input: { stateId: picked.id } });
    return { applied: true, linearState: picked.name };
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
    log("No valid cards found for Linear mode.");
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
  const issueIdByCardId = new Map();
  for (const card of syncableCards) {
    const existingId = await linearFindIssueIdByCardId(card.cardId);
    if (dryRun) {
      actions.push({ action: existingId ? "UPDATE" : "CREATE", cardId: card.cardId, linearIssueId: existingId || null });
      continue;
    }
    if (existingId) {
      await linearUpdateIssue(existingId, card);
      actions.push({ action: "UPDATED", cardId: card.cardId, linearIssueId: existingId });
      issueIdByCardId.set(card.cardId, existingId);
      if (card.status) {
        const st = await linearApplyStatus(existingId, card.status);
        actions.push({
          action: st.applied ? "STATUS_SET" : "STATUS_SKIPPED",
          cardId: card.cardId,
          linearIssueId: existingId,
          status: card.status,
          ...st,
        });
      }
    } else {
      const createdId = await linearCreateIssue(card);
      actions.push({ action: "CREATED", cardId: card.cardId, linearIssueId: createdId });
      if (createdId) issueIdByCardId.set(card.cardId, createdId);
      if (createdId && card.status) {
        const st = await linearApplyStatus(createdId, card.status);
        actions.push({
          action: st.applied ? "STATUS_SET" : "STATUS_SKIPPED",
          cardId: card.cardId,
          linearIssueId: createdId,
          status: card.status,
          ...st,
        });
      }
    }
  }

  if (!dryRun) {
    for (const edge of edges) {
      const parentId = issueIdByCardId.get(edge.parentCardId);
      const childId = issueIdByCardId.get(edge.childCardId);
      if (!parentId || !childId) continue;
      try {
        await linearSetParent(childId, parentId);
        actions.push({ action: "LINKED", parent: parentId, child: childId });
      } catch (error) {
        actions.push({ action: "LINK_FAILED", parent: parentId, child: childId, reason: error.message });
      }
    }
  }

  log("");
  log("=== LINEAR SYNC COMPLETE ===");
  for (const a of actions) log(JSON.stringify(a));
}

export async function runReverseSyncLinear(repoConfig, management) {
  if (!management.linearTeamId || !management.linearApiToken) {
    throw new Error("Linear backend requires LINEAR_TEAM_ID and LINEAR_API_TOKEN (env or config).");
  }

  const endpoint = "https://api.linear.app/graphql";
  const teamId = management.linearTeamId;
  const apiToken = management.linearApiToken;
  const statusMap = management.statusMap || {};

  log(`Backend: linear`);
  log(`Dry-run: ${dryRun ? "yes" : "no"}`);
  log("Direction: reverse (Linear -> Markdown)");

  async function linearGraphql(query, variables = {}) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) {
      const details = JSON.stringify(payload.errors || payload, null, 2);
      throw new Error(`Linear GraphQL failed: ${details}`);
    }
    return payload.data;
  }

  const issues = [];
  let cursor = null;
  while (true) {
    const query = `query($teamId: String!, $after: String) {
      team(id: $teamId) {
        issues(first: 50, after: $after, filter: { description: { containsIgnoreCase: "CARD_ID:" } }) {
          pageInfo { hasNextPage endCursor }
          nodes { id title description state { name } updatedAt }
        }
      }
    }`;
    const data = await linearGraphql(query, { teamId, after: cursor });
    const conn = data?.team?.issues;
    for (const node of conn?.nodes || []) {
      if (parseCardIdFromIssueBody(node.description || "")) issues.push(node);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  if (!issues.length) {
    log("No Linear issues with CARD_ID found.");
    return;
  }

  log(`Linear issues found: ${issues.length}`);

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

    const remoteStatus = issue.state?.name || null;
    const hyperionStatus = resolveHyperionStatusFromRemote(remoteStatus, statusMap, repoConfig);

    const converted = remoteIssueToCardMarkdown({
      title: issue.title,
      description,
      labels: [],
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
      logLabel: ` (Linear ${issue.id})`,
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
  if (!dryRun) log(`Linear reverse sync wrote: ${written} file(s)`);
  if (skipped > 0) log(`Skipped: ${skipped} issue(s).`);
}
