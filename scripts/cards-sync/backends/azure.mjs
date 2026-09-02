import fs from "node:fs/promises";
import path from "node:path";
import {
  parseOnlyFilter,
  parseCardFile,
  buildIssueTitle,
  buildRemoteDescriptionFromCard,
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

function basicAuthHeaderFromPat(pat) {
  return Buffer.from(`:${pat}`).toString("base64");
}

export function buildAzureWiqlForCardId(cardId) {
  // WIQL supports searching by substring in fields like System.Description.
  return `SELECT [System.Id] FROM WorkItems WHERE [System.Description] CONTAINS 'CARD_ID: ${cardId}' ORDER BY [System.Changed Date] DESC`;
}

export function buildAzureWiqlForAllCardIds() {
  return `SELECT [System.Id] FROM WorkItems WHERE [System.Description] CONTAINS 'CARD_ID:' ORDER BY [System.Changed Date] DESC`;
}

export async function runForwardSyncAzure(repoConfig, management) {
  if (!management.azureOrgUrl || !management.azureProject || !management.azurePat) {
    throw new Error("Azure DevOps backend requires AZDO_ORG_URL, AZDO_PROJECT, and AZDO_PAT (env or config).");
  }

  const baseUrl = String(management.azureOrgUrl).replace(/\/+$/, "");
  const project = String(management.azureProject);
  const workItemType = String(management.azureWorkItemType || "Task");
  const statusMap = management.statusMap || {};

  const auth = basicAuthHeaderFromPat(management.azurePat);

  async function azureRequest(endpoint, method = "GET", body = undefined, contentType = "application/json") {
    const url = `${baseUrl}/${encodeURIComponent(project)}${endpoint}`;
    const headers = {
      Authorization: `Basic ${auth}`,
      "Content-Type": contentType,
      Accept: "application/json",
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`Azure request failed (${response.status} ${response.statusText}): ${JSON.stringify(payload)}`);
    }
    return payload;
  }

  async function azureFindWorkItemIdByCardId(cardId) {
    const wiql = buildAzureWiqlForCardId(cardId);
    const data = await azureRequest(`/_apis/wit/wiql?api-version=7.0`, "POST", { query: wiql });
    const candidates = data?.workItems || [];
    for (const item of candidates) {
      if (!item?.id) continue;
      const wi = await azureRequest(`/_apis/wit/workitems/${item.id}?api-version=7.0&fields=System.Description`);
      const foundId = parseCardIdFromIssueBody(wi?.fields?.["System.Description"] || "");
      if (foundId === cardId) return item.id;
    }
    return null;
  }

  async function azureCreateWorkItem(card) {
    const title = buildIssueTitle(card);
    const description = buildRemoteDescriptionFromCard(card);
    const ops = [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: "/fields/System.Description", value: description },
    ];

    const data = await azureRequest(
      `/_apis/wit/workitems/${encodeURIComponent(workItemType)}?api-version=7.0`,
      "POST",
      ops,
      "application/json-patch+json"
    );
    return data?.id || null;
  }

  async function azureUpdateWorkItem(id, card) {
    const title = buildIssueTitle(card);
    const description = buildRemoteDescriptionFromCard(card);
    const ops = [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: "/fields/System.Description", value: description },
    ];

    await azureRequest(
      `/_apis/wit/workitems/${id}?api-version=7.0`,
      "PATCH",
      ops,
      "application/json-patch+json"
    );
  }

  async function azureApplyState(workItemId, hyperionStatus) {
    const state = resolveMappedStatus(statusMap, hyperionStatus);
    if (!state) return { applied: false, reason: "no_status" };
    const ops = [{ op: "add", path: "/fields/System.State", value: state }];
    try {
      await azureRequest(
        `/_apis/wit/workitems/${workItemId}?api-version=7.0`,
        "PATCH",
        ops,
        "application/json-patch+json"
      );
      return { applied: true, azureState: state };
    } catch (error) {
      return { applied: false, reason: error.message, azureState: state };
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
    log("No valid cards found for Azure mode.");
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

  log("Dry-run in Azure mode depends on your DRY_RUN/--dry-run env; no GitHub side-effects.");

  const actions = [];
  for (const card of syncableCards) {
    const existingId = await azureFindWorkItemIdByCardId(card.cardId);
    if (dryRun) {
      actions.push({
        action: existingId ? "UPDATE" : "CREATE",
        cardId: card.cardId,
        workItemId: existingId || null,
        status: card.status || null,
      });
      continue;
    }
    let workItemId = existingId;
    if (existingId) {
      await azureUpdateWorkItem(existingId, card);
      actions.push({ action: "UPDATED", cardId: card.cardId, workItemId: existingId });
    } else {
      workItemId = await azureCreateWorkItem(card);
      actions.push({ action: "CREATED", cardId: card.cardId, workItemId });
    }
    if (workItemId && card.status) {
      const st = await azureApplyState(workItemId, card.status);
      actions.push({
        action: st.applied ? "STATUS_SET" : "STATUS_SKIPPED",
        cardId: card.cardId,
        workItemId,
        status: card.status,
        ...st,
      });
    }
  }

  log("");
  log("=== AZURE DEVOPS SYNC COMPLETE ===");
  for (const a of actions) log(JSON.stringify(a));
}

export async function runReverseSyncAzure(repoConfig, management) {
  if (!management.azureOrgUrl || !management.azureProject || !management.azurePat) {
    throw new Error("Azure DevOps backend requires AZDO_ORG_URL, AZDO_PROJECT, and AZDO_PAT (env or config).");
  }

  const statusMap = management.statusMap || {};

  log(`Backend: azure-devops`);
  log(`Dry-run: ${dryRun ? "yes" : "no"}`);
  log("Direction: reverse (Azure -> Markdown)");

  const baseUrl = String(management.azureOrgUrl).replace(/\/+$/, "");
  const project = String(management.azureProject);
  const auth = basicAuthHeaderFromPat(management.azurePat);

  async function azureRequest(endpoint, method = "GET", body = undefined) {
    const url = `${baseUrl}/${encodeURIComponent(project)}${endpoint}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`Azure request failed (${response.status} ${response.statusText}): ${JSON.stringify(payload)}`);
    }
    return payload;
  }

  const wiql = await azureRequest(`/_apis/wit/wiql?api-version=7.0&$top=100`, "POST", {
    query: buildAzureWiqlForAllCardIds(),
  });
  const ids = (wiql?.workItems || []).map((w) => w.id).filter(Boolean);
  if (!ids.length) {
    log("No Azure work items with CARD_ID found.");
    return;
  }

  const batch = await azureRequest(`/_apis/wit/workitemsbatch?api-version=7.0`, "POST", {
    ids,
    fields: ["System.Id", "System.Title", "System.Description", "System.State", "System.Tags", "System.ChangedDate"],
  });
  const items = batch?.value || [];
  log(`Azure work items found: ${items.length}`);

  let written = 0;
  let skipped = 0;
  let skippedSamples = 0;
  let unchanged = 0;

  for (const item of items) {
    const fields = item?.fields || {};
    const description = fields["System.Description"] || "";
    const syncMeta = parseSyncMetadataFromDescription(description);
    const sourceFile = syncMeta?.meta?.SOURCE_FILE || parseSourceFileFromIssueBody(description);
    const cardId = syncMeta?.meta?.CARD_ID || parseCardIdFromIssueBody(description);
    if (!sourceFile) continue;

    const remoteStatus = fields["System.State"] || null;
    const hyperionStatus = resolveHyperionStatusFromRemote(remoteStatus, statusMap, repoConfig);
    const tags = String(fields["System.Tags"] || "")
      .split(";")
      .map((t) => t.trim())
      .filter(Boolean);

    const converted = remoteIssueToCardMarkdown({
      title: fields["System.Title"],
      description,
      labels: tags,
      statusOverride: hyperionStatus,
    });

    const result = await applyReverseCardFileUpdate({
      sourceFile,
      cardId,
      remoteUpdates: {
        ...(hyperionStatus ? { status: hyperionStatus } : {}),
        ...(remoteBoardSyncAt(item) ? { board_sync_at: remoteBoardSyncAt(item) } : {}),
      },
      converted,
      logLabel: ` (Azure #${item.id})`,
    });

    if (result.kind === "skipped_sample") {
      skippedSamples += 1;
      continue;
    }
    if (result.kind === "unchanged") unchanged += 1;
    else if (result.kind === "skipped") skipped += 1;
    else written += countReverseWrite(result);
  }

  if (skippedSamples > 0) log(`Skipped ${skippedSamples} kit sample work item(s).`);
  if (unchanged > 0) log(`Unchanged: ${unchanged} card(s).`);
  if (!dryRun) log(`Azure reverse sync wrote: ${written} file(s)`);
  if (skipped > 0) log(`Skipped: ${skipped} work item(s).`);
}
