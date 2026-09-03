import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import {
  parseOnlyFilter,
  expandCardIdsWithParents,
  filterEdgesForCards,
  filterKitSampleCards,
  isKitSampleCardId,
  isKitSampleRemoteArtifact,
  listCardsMarkdownFiles,
  discoverGitHubProjectNumber,
  resolveRepoConfig,
  shouldIncludeKitSamples,
  writeSyncSummary,
  parseCardIdFromIssueBody,
  parseSourceFileFromIssueBody,
  pickCanonicalIssueForCardId,
  readLocalCardFromSourceFile,
  colorFromString,
  loadLabelsCatalog,
  loadStatusColumnsCatalog,
  DEFAULT_STATUS_COLUMN_KEYS,
  DEFAULT_STATUS_OPTIONS,
  normalizeProjectSelectColor,
  parseFrontmatter,
  extractTitleFromBody,
  parseCardFile,
  splitBodyLines,
  extractCardIdFromReference,
  parseSubIssueIds,
  buildEdges,
  buildIssueTitle,
  buildJiraDescription,
  buildRemoteDescriptionFromCard,
  normalizeText,
  resolveMappedOptionValue,
  canonicalizeRemoteOption,
  buildOptionCandidates,
  resolveMappedStatus,
  parseSyncMetadataFromDescription,
  parseIssueSummaryTypeTitle,
  yamlQuote,
  yamlNullIfEmpty,
  yamlNullIfEmptyNumber,
  remoteIssueToCardMarkdown,
  buildCardMarkdownFromMeta,
  patchCardFrontmatter,
  frontmatterDiffers,
  remoteBoardSyncAt,
  inverseStatusMap,
  resolveHyperionStatusFromRemote,
  canonicalizeLinearState,
  frontmatterUpdatesFromConvertedMarkdown,
  mapWithConcurrency,
} from "./lib.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";
import {
  runForwardSyncJira,
  runReverseSyncJira,
  jiraIssueToCardMarkdown,
  pickJiraTransition,
  jiraRequest,
} from "./backends/jira.mjs";
import {
  runForwardSyncAzure,
  runReverseSyncAzure,
  buildAzureWiqlForCardId,
  buildAzureWiqlForAllCardIds,
} from "./backends/azure.mjs";
import {
  runForwardSyncGitLab,
  runReverseSyncGitLab,
  resolveGitLabStatusAction,
} from "./backends/gitlab.mjs";
import { runForwardSyncLinear, runReverseSyncLinear } from "./backends/linear.mjs";

const hyperionPaths = resolveHyperionPaths(process.cwd());
export const workspaceRoot = hyperionPaths.workspaceRoot;
export const cardsRoot = hyperionPaths.cardsRoot;
export const cardsPrefix = hyperionPaths.cardsPrefix;
const configPath = path.join(cardsRoot, "config", "projects-map.json");
const projectYmlPath = hyperionPaths.projectYmlPath;

const argDryRun = process.argv.includes("--dry-run");
const argReverse = process.argv.includes("--reverse");
const argForward = process.argv.includes("--forward");
const envDryRun = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
export const dryRun = argDryRun || envDryRun;
const directionEnv = String(process.env.SYNC_DIRECTION || "").toLowerCase();
const syncDirection = argReverse
  ? "reverse"
  : argForward
    ? "forward"
    : directionEnv === "reverse"
      ? "reverse"
      : "forward";

// ---------------------------------------------------------------------------
// Auto-detect repository from git remote
// ---------------------------------------------------------------------------

function detectRepoFromGit() {
  try {
    const url = execSync("git remote get-url origin", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    // https://github.com/OWNER/REPO.git or git@github.com:OWNER/REPO.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Auto-detect token from gh CLI
// ---------------------------------------------------------------------------

function detectTokenFromGhCli() {
  try {
    return execSync("gh auth token", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {}
  return "";
}

const repositorySlug =
  process.env.GITHUB_REPOSITORY || detectRepoFromGit() || "unknown/unknown";
const [repoOwner, repoName] = repositorySlug.split("/");

const token =
  process.env.PROJECT_SYNC_TOKEN || process.env.GITHUB_TOKEN || detectTokenFromGhCli();
const tokenSource = process.env.PROJECT_SYNC_TOKEN
  ? "PROJECT_SYNC_TOKEN"
  : process.env.GITHUB_TOKEN
    ? "GITHUB_TOKEN"
    : token
      ? "gh-cli"
      : "none";

let createMissingLabels =
  String(process.env.CREATE_MISSING_LABELS || "true").toLowerCase() === "true";

// How many cards to process in flight at once, per sync phase (create/update
// issue, body-link enrichment, Project add+fields). Sequential (1) was the
// only option before; this stays conservative by default to avoid tripping
// GitHub's secondary rate limits on a large board's first sync.
const syncConcurrency = Math.max(1, Number(process.env.CARDS_SYNC_CONCURRENCY) || 4);

export function log(message) {
  console.log(`[cards-sync] ${message}`);
}

/** Only meaningful for the GitHub backend — gh CLI/GITHUB_TOKEN don't apply to Jira/Azure/GitLab/Linear. */
function warnIfGhCliFallback() {
  if (tokenSource === "gh-cli") {
    log(
      "Warning: no PROJECT_SYNC_TOKEN/GITHUB_TOKEN set — falling back to your local `gh auth token` session. This makes REAL API calls (reads, and writes if not --dry-run) using your own GitHub identity. Set an explicit token to avoid this."
    );
  }
}

function readManagementHintsFromProjectYml(content) {
  const blockMatch = content.match(/^\s*management\s*:\s*\n([\s\S]*?)(?:^\S|\Z)/m);
  if (!blockMatch) return {};

  const block = blockMatch[1];
  const pick = (key) => {
    const m = block.match(new RegExp(`^\\s*${key}\\s*:\\s*([^\\n#]+)`, "m"));
    if (!m) return null;
    const value = String(m[1]).trim().replace(/^["']|["']$/g, "");
    return value === "null" ? null : value;
  };

  return {
    backend: pick("backend"),
    url: pick("url"),
    project_key: pick("project_key"),
    email: pick("email"),
    org: pick("org"),
    project: pick("project"),
    team: pick("team"),
    status_map: parseStatusMapBlock(block),
  };
}

function parseStatusMapBlock(managementBlock) {
  const mapMatch = managementBlock.match(/^\s*status_map\s*:\s*\n((?:\s+.+\n?)*)/m);
  if (!mapMatch) return {};
  const map = {};
  for (const line of mapMatch[1].split("\n")) {
    const m = line.match(/^\s{2,}["']?([^"':]+)["']?\s*:\s*["']?([^"'\n#]+)["']?\s*$/);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}

async function resolveManagementConfig(repoConfig) {
  let projectYmlManagement = {};
  try {
    const raw = await fs.readFile(projectYmlPath, "utf8");
    projectYmlManagement = readManagementHintsFromProjectYml(raw);
  } catch {}

  const cfgManagement = repoConfig.management || {};

  return {
    backend:
      process.env.CARDS_SYNC_BACKEND ||
      cfgManagement.backend ||
      projectYmlManagement.backend ||
      repoConfig.backend ||
      "github",
    // ----------------------------
    // Jira
    // ----------------------------
    jiraUrl:
      process.env.JIRA_URL ||
      cfgManagement.url ||
      projectYmlManagement.url ||
      null,
    jiraProjectKey:
      process.env.JIRA_PROJECT_KEY ||
      cfgManagement.project_key ||
      projectYmlManagement.project_key ||
      null,
    jiraEmail:
      process.env.JIRA_EMAIL ||
      cfgManagement.email ||
      projectYmlManagement.email ||
      null,
    jiraApiToken: process.env.JIRA_API_TOKEN || null,
    jiraIssueType: process.env.JIRA_ISSUE_TYPE || "Task",

    // ----------------------------
    // Azure DevOps
    // ----------------------------
    azureOrgUrl: process.env.AZDO_ORG_URL || cfgManagement.org || projectYmlManagement.org || null,
    azureProject: process.env.AZDO_PROJECT || cfgManagement.project || projectYmlManagement.project || null,
    azurePat: process.env.AZDO_PAT || null,
    azureWorkItemType: process.env.AZDO_WORK_ITEM_TYPE || "Task",

    // ----------------------------
    // Linear
    // ----------------------------
    linearTeamId: process.env.LINEAR_TEAM_ID || cfgManagement.team || projectYmlManagement.team || null,
    linearApiToken: process.env.LINEAR_API_TOKEN || null,
    statusMap: cfgManagement.status_map || projectYmlManagement.status_map || {},

    // ----------------------------
    // GitLab
    // ----------------------------
    gitlabUrl: process.env.GITLAB_URL || cfgManagement.url || projectYmlManagement.url || "https://gitlab.com",
    gitlabProjectId: process.env.GITLAB_PROJECT_ID || null,
    gitlabToken: process.env.GITLAB_TOKEN || null,
    gitlabIssueType: process.env.GITLAB_ISSUE_TYPE || null,
  };
}

// ---------------------------------------------------------------------------
// File listing
// ---------------------------------------------------------------------------

export async function listMarkdownFiles(dir) {
  return listCardsMarkdownFiles(dir, { forSync: true });
}

/**
 * listMarkdownFiles() excludes the whole _examples/ directory at the walk
 * level (unlike validate.mjs, which includes it) — so an all-kit-samples
 * repo silently prints "No card files found" with no clue why `cards:validate`
 * just reported real cards. Check whether that's the actual cause and say so.
 */
export async function logNoCardFilesFound(dir) {
  log(`No card files found in ${cardsPrefix}/`);
  const withSamples = await listCardsMarkdownFiles(dir, { forSync: false });
  if (withSamples.length > 0) {
    log(
      `  (${withSamples.length} kit sample card(s) under _examples/ excluded from sync — expected. Add real cards under epics/features/stories/tasks/.)`
    );
  }
}

function issueUrl(owner, name, number) {
  return `https://github.com/${owner}/${name}/issues/${number}`;
}

function formatCardReference(cardId, issueByCardId, owner, name) {
  const issue = issueByCardId?.get(cardId);
  if (!issue?.number) return cardId;
  const url = issueUrl(owner, name, issue.number);
  return `[${cardId} (#${issue.number})](${url})`;
}

function formatParentFieldValue(cardId, issueByCardId, owner, name) {
  if (!cardId) return "";
  const issue = issueByCardId?.get(cardId);
  if (!issue?.number) return cardId;
  return `${issueUrl(owner, name, issue.number)} (${cardId})`;
}

function enrichBodySubIssues(body, issueByCardId, owner, name) {
  const lines = splitBodyLines(body);
  let inSection = false;

  return lines
    .map((line) => {
      if (/^##\s+.*[Ss]ub-issues/i.test(line)) {
        inSection = true;
        return line;
      }
      if (inSection && /^##\s+/.test(line)) inSection = false;
      if (!inSection) return line;

      const bullet = line.match(/^([-*]\s+)(.+)$/);
      if (!bullet) return line;
      const ref = bullet[2].trim();
      if (/^\[[^\]]+\]\([^)]+\)/.test(ref)) return line;

      const cardId = extractCardIdFromReference(ref);
      if (!issueByCardId?.has(cardId)) return line;
      return `${bullet[1]}${formatCardReference(cardId, issueByCardId, owner, name)}`;
    })
    .join("\n");
}

function enrichBodyWithParentSection(body, card, issueByCardId, owner, name) {
  if (!card.parent || !issueByCardId?.has(card.parent)) return body;

  if (/^##\s+.*\b[Pp]arent\b/i.test(body)) {
    const lines = splitBodyLines(body);
    let inSection = false;
    return lines
      .map((line) => {
        if (/^##\s+.*\b[Pp]arent\b/i.test(line)) {
          inSection = true;
          return line;
        }
        if (inSection && /^##\s+/.test(line)) inSection = false;
        if (!inSection) return line;

        const bullet = line.match(/^([-*]\s+)(.+)$/);
        if (!bullet) return line;
        const cardId = extractCardIdFromReference(bullet[2]);
        if (!issueByCardId.has(cardId)) return line;
        return `${bullet[1]}${formatCardReference(cardId, issueByCardId, owner, name)}`;
      })
      .join("\n");
  }

  const parentLink = formatCardReference(card.parent, issueByCardId, owner, name);
  const block = `## 👆 Parent\n\n- ${parentLink}\n\n`;
  const subMatch = body.match(/\n##\s+.*[Ss]ub-issues/i);
  if (subMatch?.index !== undefined) {
    return `${body.slice(0, subMatch.index)}\n${block}${body.slice(subMatch.index + 1)}`;
  }
  const resumoMatch = body.match(/\n##\s+Resumo/i);
  if (resumoMatch?.index !== undefined) {
    return `${body.slice(0, resumoMatch.index)}\n${block}${body.slice(resumoMatch.index + 1)}`;
  }
  return `${body.trim()}\n\n${block}`;
}

const DISPLAY_SECTION_REPLACEMENTS = [
  [/^##\s+Sub-issues\s*$/i, "## 🔗 Sub-issues"],
  [/^##\s+Parent\s*$/i, "## 👆 Parent"],
  [/^##\s+Resumo\s*$/i, "## 📋 Resumo"],
  [/^##\s+Descrição\s*$/i, "## 📝 Descrição"],
  [/^##\s+Critérios de Aceite\s*$/i, "## ✅ Critérios de Aceite"],
  [/^##\s+Implementação\s*$/i, "## 🛠️ Implementação"],
  [/^##\s+Regras de Negócio\s*$/i, "## 📐 Regras de Negócio"],
  [/^##\s+Protótipo e UX\/UI\s*$/i, "## 🎨 Protótipo e UX/UI"],
  [/^###\s+CONCLUIDO\s*$/i, "### ✅ Concluído"],
  [/^###\s+Concluído\s*$/i, "### ✅ Concluído"],
  [/^###\s+PENDENTE\s*$/i, "### ⏳ Pendente"],
  [/^###\s+Pendente\s*$/i, "### ⏳ Pendente"],
];

function lineHasDisplayEmoji(line) {
  return /[\u{1F300}-\u{1FAFF}]/u.test(line);
}

function beautifyCardBodyForDisplay(body) {
  return splitBodyLines(body)
    .map((line) => {
      if (lineHasDisplayEmoji(line)) return line;
      for (const [pattern, replacement] of DISPLAY_SECTION_REPLACEMENTS) {
        if (pattern.test(line.trim())) return replacement;
      }
      return line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Issue body with sync metadata
// ---------------------------------------------------------------------------

function buildIssueBody(card, linkContext = null) {
  let body = card.body.trim();
  if (linkContext) {
    body = beautifyCardBodyForDisplay(body);
    body = enrichBodySubIssues(body, linkContext.issueByCardId, linkContext.owner, linkContext.name);
    body = enrichBodyWithParentSection(body, card, linkContext.issueByCardId, linkContext.owner, linkContext.name);
  }

  const lines = [body, "", "---"];

  if (linkContext) {
    lines.push("", "> **🔄 Hyperion sync**", ">");
    lines.push(`> - **Card:** \`${card.cardId}\``);
    if (card.parent) {
      lines.push(
        `> - **Parent:** ${formatCardReference(card.parent, linkContext.issueByCardId, linkContext.owner, linkContext.name)}`
      );
    }
    lines.push(`> - **Source:** \`${card.relativeFile}\``);
    lines.push("");
  }

  lines.push("<!-- SYNC_METADATA — do not edit below this line -->");
  lines.push(`CARD_ID: ${card.cardId}`);
  lines.push(`SOURCE_FILE: ${card.relativeFile}`);
  if (card.parent) {
    lines.push(`PARENT_CARD_ID: ${card.parent}`);
  }
  if (card.boardSyncAt) {
    lines.push(`BOARD_SYNC_AT: ${card.boardSyncAt}`);
  }
  lines.push("<!-- /SYNC_METADATA -->");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub GraphQL
// ---------------------------------------------------------------------------

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "cards-sync-script",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    const details = JSON.stringify(payload.errors || payload, null, 2);
    throw new Error(`GraphQL failed: ${details}`);
  }
  return payload.data;
}

async function getRepositoryNodeId(owner, name) {
  const data = await graphql(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
    { owner, name }
  );
  return data.repository.id;
}

async function loadIssueMapByCardId(owner, name) {
  const map = new Map();
  let endCursor = null;
  let hasNextPage = true;
  let skippedSamples = 0;

  while (hasNextPage) {
    const data = await graphql(
      `query($owner: String!, $name: String!, $endCursor: String) {
        repository(owner: $owner, name: $name) {
          issues(first: 100, after: $endCursor, states: [OPEN, CLOSED]) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id number title url body updatedAt state
              labels(first: 30) { nodes { name } }
            }
          }
        }
      }`,
      { owner, name, endCursor }
    );

    for (const issue of data.repository?.issues?.nodes || []) {
      if (!issue?.id) continue;
      const cardId = parseCardIdFromIssueBody(issue.body);
      const sourceFile = parseSourceFileFromIssueBody(issue.body);
      if (!cardId) continue;
      if (isKitSampleRemoteArtifact({ cardId, sourceFile })) {
        skippedSamples += 1;
        continue;
      }
      const labels = (issue.labels?.nodes || []).map((l) => l.name).filter(Boolean);
      const enriched = { ...issue, labels };
      map.set(cardId, pickCanonicalIssueForCardId(map.get(cardId), enriched));
    }

    hasNextPage = Boolean(data.repository?.issues?.pageInfo?.hasNextPage);
    endCursor = data.repository?.issues?.pageInfo?.endCursor || null;
  }

  if (skippedSamples > 0) {
    log(
      `Ignored ${skippedSamples} remote kit sample issue(s) (EXAMPLE/TEMPLATE/SAMPLE — not mapped for sync).`
    );
  }

  return map;
}

async function searchIssueByCardId(owner, name, cardId, issueMapCache = null) {
  if (isKitSampleCardId(cardId) && !shouldIncludeKitSamples()) return null;
  const map = issueMapCache || (await loadIssueMapByCardId(owner, name));
  return map.get(cardId) || null;
}

async function createIssue(repositoryId, title, body) {
  const data = await graphql(
    `mutation($repositoryId: ID!, $title: String!, $body: String!) { createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body }) { issue { id number title url } } }`,
    { repositoryId, title, body }
  );
  return data.createIssue.issue;
}

async function updateIssue(issueId, title, body) {
  const data = await graphql(
    `mutation($issueId: ID!, $title: String!, $body: String!) { updateIssue(input: { id: $issueId, title: $title, body: $body }) { issue { id number title url } } }`,
    { issueId, title, body }
  );
  return data.updateIssue.issue;
}

async function linkAsSubIssue(parentIssueId, childIssueId) {
  await graphql(
    `mutation($issueId: ID!, $subIssueId: ID!) { addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) { issue { id } } }`,
    { issueId: parentIssueId, subIssueId: childIssueId }
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Catalog loaded during forward sync (name → { color, description }). */
let labelsCatalogByName = new Map();

async function getLabelId(owner, name, labelName, createIfMissing = false) {
  const spec = labelsCatalogByName.get(labelName);
  const desiredColor = spec?.color || colorFromString(labelName);
  const desiredDescription = spec?.description ?? "";

  const data = await graphql(
    `query($owner: String!, $name: String!, $labelName: String!) {
      repository(owner: $owner, name: $name) {
        id
        label(name: $labelName) { id color description }
      }
    }`,
    { owner, name, labelName }
  );

  const existing = data.repository.label;
  if (existing?.id) {
    const currentColor = String(existing.color || "").replace(/^#/, "").toLowerCase();
    const currentDescription = existing.description || "";
    if (
      currentColor !== desiredColor ||
      (desiredDescription && currentDescription !== desiredDescription)
    ) {
      await graphql(
        `mutation($id: ID!, $color: String!, $description: String) {
          updateLabel(input: { id: $id, color: $color, description: $description }) {
            label { id }
          }
        }`,
        { id: existing.id, color: desiredColor, description: desiredDescription || null }
      );
    }
    return existing.id;
  }

  if (!createIfMissing) return "";

  const repositoryId = data.repository.id;
  try {
    const created = await graphql(
      `mutation($repositoryId: ID!, $name: String!, $color: String!, $description: String) {
        createLabel(input: {
          repositoryId: $repositoryId
          name: $name
          color: $color
          description: $description
        }) { label { id } }
      }`,
      {
        repositoryId,
        name: labelName,
        color: desiredColor,
        description: desiredDescription || null,
      }
    );
    return created.createLabel.label.id;
  } catch (error) {
    const msg = String(error.message || "");
    if (!msg.includes("already been taken") && !msg.includes("Name has already been taken")) {
      throw error;
    }
    const retry = await graphql(
      `query($owner: String!, $name: String!, $labelName: String!) {
        repository(owner: $owner, name: $name) {
          label(name: $labelName) { id }
        }
      }`,
      { owner, name, labelName }
    );
    return retry.repository?.label?.id || "";
  }
}

async function setIssueLabels(issueId, owner, name, labels) {
  if (!labels.length) return;

  const labelIds = [];
  const skipped = [];

  for (const labelName of labels) {
    const labelId = await getLabelId(owner, name, labelName, createMissingLabels);
    if (!labelId) {
      skipped.push(labelName);
      continue;
    }
    labelIds.push(labelId);
  }

  if (skipped.length) log(`Labels skipped (not found): ${skipped.join(", ")}`);
  if (!labelIds.length) return;

  await graphql(
    `mutation($labelableId: ID!, $labelIds: [ID!]!) { addLabelsToLabelable(input: { labelableId: $labelableId, labelIds: $labelIds }) { clientMutationId } }`,
    { labelableId: issueId, labelIds }
  );
}

// ---------------------------------------------------------------------------
// Project operations
// ---------------------------------------------------------------------------

async function getProject(owner, projectNumber) {
  const projectFieldsFragment = `fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField {
        id name options { id name color description }
      }
      ... on ProjectV2IterationField { id name configuration { iterations { id title } } }
    }
  }`;

  // Try repository-level project first
  try {
    const data = await graphql(
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { projectV2(number: $number) { id ${projectFieldsFragment} } } }`,
      { owner, name: repoName, number: projectNumber }
    );
    if (data.repository?.projectV2) return data.repository.projectV2;
  } catch {}

  // Try user-level
  try {
    const data = await graphql(
      `query($owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) { id ${projectFieldsFragment} } } }`,
      { owner, number: projectNumber }
    );
    if (data.user?.projectV2) return data.user.projectV2;
  } catch {}

  // Try organization-level
  try {
    const data = await graphql(
      `query($owner: String!, $number: Int!) { organization(login: $owner) { projectV2(number: $number) { id ${projectFieldsFragment} } } }`,
      { owner, number: projectNumber }
    );
    if (data.organization?.projectV2) return data.organization.projectV2;
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// Auto-create Project with default fields
// ---------------------------------------------------------------------------

const DEFAULT_TYPE_OPTIONS = ["Epic", "Feature", "Story", "Task", "Subtask", "Bug"];
const DEFAULT_PRIORITY_OPTIONS = ["Highest", "High", "Medium", "Low"];
const TYPE_OPTION_COLORS = {
  Epic: "PURPLE",
  Feature: "BLUE",
  Story: "GREEN",
  Task: "YELLOW",
  Subtask: "GRAY",
  Bug: "RED",
};
const PRIORITY_OPTION_COLORS = {
  Highest: "RED",
  High: "ORANGE",
  Medium: "YELLOW",
  Low: "GRAY",
};

function coerceFieldOptionSpecs(options, fieldKey = null) {
  return options.map((entry, i) => {
    if (typeof entry === "string") {
      return {
        name: entry,
        color: optionColorForField(fieldKey, entry, i),
        description: "",
      };
    }
    const name = String(entry.name || entry.key || "").trim();
    return {
      name,
      color: normalizeProjectSelectColor(
        entry.color,
        optionColorForField(fieldKey, name, i)
      ),
      description: typeof entry.description === "string" ? entry.description.trim() : "",
    };
  });
}

function buildSingleSelectOptionInputs(specs, existingOptions = []) {
  const byName = new Map();
  for (const opt of existingOptions) {
    byName.set(normalizeText(opt.name), opt);
  }
  return specs.map((spec) => {
    const existing = byName.get(normalizeText(spec.name));
    const input = {
      name: spec.name,
      color: spec.color,
      description: spec.description || "",
    };
    if (existing?.id) input.id = existing.id;
    return input;
  });
}

function statusColumnMetadataDrift(desiredSpecs, existingOptions) {
  for (const spec of desiredSpecs) {
    const existing = (existingOptions || []).find(
      (opt) => normalizeText(opt.name) === normalizeText(spec.name)
    );
    if (!existing) continue;
    const colorOk =
      String(existing.color || "").toUpperCase() === String(spec.color || "").toUpperCase();
    const descOk = (existing.description || "") === (spec.description || "");
    if (!colorOk || !descOk) return true;
  }
  return false;
}

async function createProjectV2(ownerId, title, repositoryId = null) {
  const data = await graphql(
    `mutation($ownerId: ID!, $title: String!, $repositoryId: ID) {
      createProjectV2(input: { ownerId: $ownerId, title: $title, repositoryId: $repositoryId }) {
        projectV2 { id number }
      }
    }`,
    { ownerId, title, repositoryId }
  );
  return data.createProjectV2.projectV2;
}

async function getProjectLinkedRepositorySlugs(projectId) {
  const data = await graphql(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          repositories(first: 20) { nodes { nameWithOwner } }
        }
      }
    }`,
    { projectId }
  );
  return (data.node?.repositories?.nodes || []).map((r) => r.nameWithOwner).filter(Boolean);
}

async function linkProjectToRepository(projectId, repositoryId) {
  await graphql(
    `mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
        repository { nameWithOwner }
      }
    }`,
    { projectId, repositoryId }
  );
}

async function ensureProjectRepositoryLink(project, repositoryId, repositorySlug) {
  if (!project?.id || !repositoryId) return false;

  const linked = await getProjectLinkedRepositorySlugs(project.id);
  if (linked.includes(repositorySlug)) return false;

  await linkProjectToRepository(project.id, repositoryId);
  log(`  + Project linked to repository: ${repositorySlug}`);
  return true;
}

async function addSingleSelectField(projectId, name, options, fieldKey = null) {
  const specs = coerceFieldOptionSpecs(options, fieldKey);
  const data = await graphql(
    `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: {
        projectId: $projectId,
        dataType: SINGLE_SELECT,
        name: $name,
        singleSelectOptions: $options
      }) { projectV2Field { ... on ProjectV2SingleSelectField { id name } } }
    }`,
    {
      projectId,
      name,
      options: buildSingleSelectOptionInputs(specs),
    }
  );
  return data.createProjectV2Field.projectV2Field;
}

async function addTextField(projectId, name) {
  await graphql(
    `mutation($projectId: ID!, $name: String!) {
      createProjectV2Field(input: { projectId: $projectId, dataType: TEXT, name: $name }) {
        projectV2Field { ... on ProjectV2Field { id } }
      }
    }`,
    { projectId, name }
  );
}

async function addNumberField(projectId, name) {
  await graphql(
    `mutation($projectId: ID!, $name: String!) {
      createProjectV2Field(input: { projectId: $projectId, dataType: NUMBER, name: $name }) {
        projectV2Field { ... on ProjectV2Field { id } }
      }
    }`,
    { projectId, name }
  );
}

async function addDateField(projectId, name) {
  await graphql(
    `mutation($projectId: ID!, $name: String!) {
      createProjectV2Field(input: { projectId: $projectId, dataType: DATE, name: $name }) {
        projectV2Field { ... on ProjectV2Field { id } }
      }
    }`,
    { projectId, name }
  );
}

function formatDateISO(date) {
  return date.toISOString().slice(0, 10);
}

function resolveSprintFieldConfig(repoConfig) {
  const sprintField = repoConfig.sprintField || {};
  const durationDays = Number(sprintField.durationDays || 14);
  const startDate = sprintField.startDate || formatDateISO(new Date());
  const seedIterations = Array.isArray(sprintField.seedIterations) ? sprintField.seedIterations : [];
  return { durationDays, startDate, seedIterations };
}

async function addIterationField(projectId, name, repoConfig) {
  const { durationDays, startDate, seedIterations } = resolveSprintFieldConfig(repoConfig);
  const iterations = seedIterations.map((it) => ({
    title: String(it.title),
    startDate: String(it.startDate),
    duration: Number(it.duration || durationDays),
  }));

  await graphql(
    `mutation($projectId: ID!, $name: String!, $config: ProjectV2IterationFieldConfigurationInput!) {
      createProjectV2Field(input: {
        projectId: $projectId,
        dataType: ITERATION,
        name: $name,
        iterationConfiguration: $config
      }) {
        projectV2Field { ... on ProjectV2IterationField { id name } }
      }
    }`,
    {
      projectId,
      name,
      config: {
        duration: durationDays,
        startDate,
        iterations,
      },
    }
  );
}

async function ensureSprintField(project, repoConfig) {
  const fieldMap = repoConfig.fieldMap || {};
  const configuredName = fieldMap.sprint || "Sprint";
  const candidates = [configuredName, ...(FIELD_NAME_ALIASES.sprint || [])];

  let sprintField = null;
  for (const candidate of candidates) {
    const found = getFieldByName(project, candidate);
    if (found) {
      sprintField = found;
      break;
    }
  }

  if (sprintField) {
    if (sprintField.__typename !== "ProjectV2IterationField") {
      log(`  WARN: Sprint field "${sprintField.name}" exists but is not Iteration type`);
      return;
    }
    const count = sprintField.configuration?.iterations?.length || 0;
    log(
      `  = Sprint iteration field exists: ${sprintField.name}${
        count ? ` (${count} iteration(s))` : " (no iterations yet — configure in Project Settings)"
      }`
    );
    return;
  }

  try {
    await addIterationField(project.id, configuredName, repoConfig);
    log(`  + Sprint iteration field created: ${configuredName}`);
  } catch (error) {
    log(`  WARN: Could not create Sprint iteration field: ${error.message}`);
    log("  Create an Iteration field manually in Project Settings if needed.");
  }
}

async function updateSingleSelectFieldOptions(fieldId, options, fieldKey = null, existingOptions = []) {
  const specs = coerceFieldOptionSpecs(options, fieldKey);
  const data = await graphql(
    `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
        projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name color description } } }
      }
    }`,
    {
      fieldId,
      options: buildSingleSelectOptionInputs(specs, existingOptions),
    }
  );
  return data.updateProjectV2Field.projectV2Field;
}

async function applySelectFieldColors(field, colorByName, label, descriptionByName = {}) {
  if (!field || field.__typename !== "ProjectV2SingleSelectField") return;

  const options = (field.options || []).map((opt, i) => ({
    id: opt.id,
    name: opt.name,
    color: colorByName[opt.name] || singleSelectColor(i),
    description: descriptionByName[opt.name] ?? opt.description ?? "",
  }));

  try {
    await graphql(
      `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
          projectV2Field { ... on ProjectV2SingleSelectField { id name } }
        }
      }`,
      { fieldId: field.id, options }
    );
    log(`  ~ ${label} colors updated (${options.length} options)`);
  } catch (error) {
    log(`  WARN: Could not update ${label} colors: ${error.message}`);
  }
}

async function ensureKitFieldColors(project, repoConfig) {
  const fieldMap = repoConfig.fieldMap || {};
  const typeField = getFieldByName(project, fieldMap.type || "Type")
    || getFieldByName(project, "Tipo");
  const priorityField = getFieldByName(project, fieldMap.priority || "Priority");

  await applySelectFieldColors(typeField, TYPE_OPTION_COLORS, "Type/Tipo");
  await applySelectFieldColors(priorityField, PRIORITY_OPTION_COLORS, "Priority");
}

const HYPERION_PROJECT_VIEWS = [
  { name: "Board", layout: "BOARD_LAYOUT" },
  { name: "Tabela", layout: "TABLE_LAYOUT" },
  { name: "Roadmap", layout: "ROADMAP_LAYOUT" },
];

function isKitViewsConfigured(views) {
  return (
    views.length === 3 &&
    views[0]?.name === "Board" &&
    views[0]?.layout === "BOARD_LAYOUT" &&
    views[1]?.name === "Tabela" &&
    views[1]?.layout === "TABLE_LAYOUT" &&
    views[2]?.name === "Roadmap" &&
    views[2]?.layout === "ROADMAP_LAYOUT"
  );
}

async function listProjectViews(projectId) {
  const data = await graphql(
    `query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          views(first: 20, orderBy: { field: POSITION, direction: ASC }) {
            nodes { id name layout }
          }
        }
      }
    }`,
    { id: projectId }
  );
  return data.node?.views?.nodes || [];
}

async function deleteProjectView(viewId) {
  await graphql(
    `mutation($viewId: ID!) {
      deleteProjectV2View(input: { viewId: $viewId }) { projectV2View { id } }
    }`,
    { viewId }
  );
}

async function createProjectView(projectId, name, layout) {
  await graphql(
    `mutation($projectId: ID!, $name: String!, $layout: ProjectV2ViewLayout!) {
      createProjectV2View(input: { projectId: $projectId, name: $name, layout: $layout }) {
        projectV2View { id name layout }
      }
    }`,
    { projectId, name, layout }
  );
}

async function updateProjectView(viewId, { name, layout }) {
  await graphql(
    `mutation($viewId: ID!, $name: String, $layout: ProjectV2ViewLayout) {
      updateProjectV2View(input: { viewId: $viewId, name: $name, layout: $layout }) {
        projectV2View { id name layout }
      }
    }`,
    { viewId, name, layout }
  );
}

async function ensureKitProjectViews(project) {
  if (!project?.id) return;

  let views = await listProjectViews(project.id);
  if (isKitViewsConfigured(views)) {
    log("  = Project views already configured (Board → Tabela → Roadmap)");
    return;
  }

  log("  Configuring project views (Board → Tabela → Roadmap)...");

  try {
    if (!views.length) {
      for (const spec of HYPERION_PROJECT_VIEWS) {
        await createProjectView(project.id, spec.name, spec.layout);
      }
      log("  + Project views created");
      return;
    }

    await updateProjectView(views[0].id, {
      name: HYPERION_PROJECT_VIEWS[0].name,
      layout: HYPERION_PROJECT_VIEWS[0].layout,
    });

    for (let i = views.length - 1; i >= 1; i--) {
      await deleteProjectView(views[i].id);
    }

    await createProjectView(project.id, HYPERION_PROJECT_VIEWS[1].name, HYPERION_PROJECT_VIEWS[1].layout);
    await createProjectView(project.id, HYPERION_PROJECT_VIEWS[2].name, HYPERION_PROJECT_VIEWS[2].layout);
    log("  + Project views configured");
  } catch (error) {
    log(`  WARN: Could not configure project views automatically: ${error.message}`);
    log("  Customize views manually: Board (first) → Tabela → Roadmap");
  }
}

async function ensureStatusFieldOptions(project, repoConfig) {
  const fieldMap = repoConfig.fieldMap || {};
  const statusName = fieldMap.status || "Status";
  const catalog = await loadStatusColumnsCatalog({
    cardsRoot,
    repoConfig,
    projectLocale: await detectProjectLocale(),
  });
  const desiredSpecs = catalog.specs;

  let statusField = getFieldByName(project, statusName);

  if (!statusField) {
    await addSingleSelectField(project.id, statusName, desiredSpecs);
    log(`  + Status field created (${desiredSpecs.length} columns, colors + descriptions)`);
    return;
  }

  if (statusField.__typename !== "ProjectV2SingleSelectField") return;

  const existing = statusField.options || [];
  const existingNames = new Set(existing.map((o) => normalizeText(o.name)));
  const missing = desiredSpecs.filter((spec) => !existingNames.has(normalizeText(spec.name)));
  const metadataDrift = statusColumnMetadataDrift(desiredSpecs, existing);

  if (!missing.length && !metadataDrift) {
    log(`  = Status columns OK (${desiredSpecs.length} options, metadata synced)`);
    return;
  }

  try {
    await updateSingleSelectFieldOptions(
      statusField.id,
      desiredSpecs,
      "status",
      existing
    );
    if (missing.length) {
      log(`  ~ Status field updated — added ${missing.length} missing column(s)`);
    } else {
      log(`  ~ Status columns updated (colors + descriptions)`);
    }
  } catch (error) {
    log(`  WARN: Could not update Status options automatically: ${error.message}`);
    log(`  Customize Status columns manually in Project Settings.`);
  }
}

function singleSelectColor(index) {
  const colors = ["GREEN", "YELLOW", "ORANGE", "RED", "PURPLE", "BLUE", "PINK", "GRAY"];
  return colors[index % colors.length];
}

function optionColorForField(fieldKey, optionName, index) {
  if (fieldKey === "type") return TYPE_OPTION_COLORS[optionName] || singleSelectColor(index);
  if (fieldKey === "priority") return PRIORITY_OPTION_COLORS[optionName] || singleSelectColor(index);
  return singleSelectColor(index);
}

async function getOwnerNodeId(owner) {
  // createProjectV2 requires a User or Organization node — not a Repository node.
  try {
    const data = await graphql(`query($login: String!) { user(login: $login) { id } }`, { login: owner });
    if (data.user?.id) return data.user.id;
  } catch {}

  try {
    const data = await graphql(`query($login: String!) { organization(login: $login) { id } }`, { login: owner });
    if (data.organization?.id) return data.organization.id;
  } catch {}

  return null;
}

// Fields the sync expects to exist. Names here are the defaults used when creating.
// The fieldMap in config can override these names to match an existing Project.
const REQUIRED_FIELDS = [
  { key: "type", defaultName: "Type", kind: "single_select", options: DEFAULT_TYPE_OPTIONS },
  { key: "priority", defaultName: "Priority", kind: "single_select", options: DEFAULT_PRIORITY_OPTIONS },
  { key: "sprint", defaultName: "Sprint", kind: "iteration" },
  { key: "storyPoints", defaultName: "Story Points", kind: "number" },
  { key: "reporter", defaultName: "Reporter", kind: "text" },
  { key: "parent", defaultName: "Parent (Epic/Feature)", kind: "text" },
  { key: "dueDate", defaultName: "Due Date", kind: "date" },
];

async function autoCreateProject(owner, repoConfig) {
  log("Project not found. Auto-creating...");

  const ownerId = await getOwnerNodeId(owner);
  if (!ownerId) {
    throw new Error(`Cannot resolve owner node ID for "${owner}". Check permissions.`);
  }

  // Name requirement: "[RepoName] Hyperion Project"
  const projectTitle = `${repoName} Hyperion Project`;
  const repositoryId = await getRepositoryNodeId(repoOwner, repoName);
  const created = await createProjectV2(ownerId, projectTitle, repositoryId);
  log(`Project created: "${projectTitle}" (number ${created.number})`);
  if (repositoryId) {
    log(`  + Default repository: ${repoOwner}/${repoName}`);
  }

  // Fetch newly created project to see existing fields (Status is auto-created by GitHub)
  const project = await getProject(owner, created.number);
  const existingNames = new Set(
    (project?.fields?.nodes || []).map((f) => f?.name?.toLowerCase()).filter(Boolean)
  );

  const fieldMap = repoConfig.fieldMap || {};

  for (const spec of REQUIRED_FIELDS) {
    const name = fieldMap[spec.key] || spec.defaultName;
    if (existingNames.has(name.toLowerCase())) {
      log(`  = Field exists: ${name} (skip)`);
      continue;
    }

    if (spec.kind === "single_select") {
      await addSingleSelectField(project.id, name, spec.options, spec.key);
    } else if (spec.kind === "number") {
      await addNumberField(project.id, name);
    } else if (spec.kind === "text") {
      await addTextField(project.id, name);
    } else if (spec.kind === "date") {
      await addDateField(project.id, name);
    } else if (spec.kind === "iteration") {
      await addIterationField(project.id, name, repoConfig);
    }
    log(`  + Field created: ${name}`);
  }

  const refreshed = await getProject(owner, created.number);
  await ensureStatusFieldOptions(refreshed, repoConfig);
  await ensureKitFieldColors(refreshed, repoConfig);
  await ensureKitProjectViews(refreshed);
  await ensureSprintField(refreshed, repoConfig);

  // Auto-save projectNumber back to config
  try {
    const rawConfig = await fs.readFile(configPath, "utf8");
    const configObj = JSON.parse(rawConfig);
    const target = configObj.default || (configObj.default = {});
    target.projectNumber = created.number;
    if (!target.projectOwner) target.projectOwner = owner;
    await fs.writeFile(configPath, JSON.stringify(configObj, null, 2) + "\n", "utf8");
    log(`  projects-map.json updated: projectNumber=${created.number}, projectOwner=${owner}`);
  } catch (e) {
    log(`  Could not auto-save projectNumber to config: ${e.message}`);
    log(`  Manually set "projectNumber": ${created.number} in projects-map.json`);
  }

  log("");
  log("NOTE: Status field configured with Hyperion workflow columns (semantic colors + descriptions).");
  log("Sprint iteration field configured (cards may keep sprint: null until sprints are defined).");

  return created;
}

function getFieldByName(project, fieldName) {
  if (!project || !fieldName) return null;
  const fields = project.fields?.nodes || [];
  return fields.find((f) => f?.name?.toLowerCase() === fieldName.toLowerCase()) || null;
}

export function applyKitSampleFilter(cards, onlyIds) {
  const { cards: filtered, skipped, ignoredOnlyTargets } = filterKitSampleCards(cards, onlyIds);
  if (skipped > 0) {
    log(
      `Skipping ${skipped} kit sample card(s) (EXAMPLE/TEMPLATE/SAMPLE — reference only). Real project cards sync normally.`
    );
  }
  if (ignoredOnlyTargets.length) {
    log(
      `Ignored kit sample target(s): ${ignoredOnlyTargets.join(", ")} (use --include-samples only for kit maintenance).`
    );
  }
  return filtered;
}

const FIELD_NAME_ALIASES = {
  status: ["Status"],
  type: ["Type", "Tipo"],
  priority: ["Priority", "Prioridade"],
  sprint: ["Sprint", "Numero da Sprint", "Número da Sprint"],
  storyPoints: ["Story Points"],
  reporter: ["Reporter", "Relator"],
  parent: ["Parent (Epic/Feature)", "Pai (Epic/Feature)"],
  dueDate: ["Due Date", "Data Limite"],
};

function resolveProjectField(project, key, fieldMap = {}) {
  const configured = fieldMap[key];
  const candidates = [];
  if (configured) candidates.push(configured);
  candidates.push(...(FIELD_NAME_ALIASES[key] || []));

  for (const name of candidates) {
    const found = getFieldByName(project, name);
    if (found) return found;
  }
  return null;
}

function pickSingleSelectOption(field, value, context = {}) {
  if (!value || !field?.options?.length) return "";
  const candidates = buildOptionCandidates(context.fieldKey, value, context.repoConfig);
  const options = field.options || [];

  for (const wanted of candidates) {
    const exact = options.find((o) => normalizeText(o.name) === normalizeText(wanted));
    if (exact) return exact.id;
  }

  for (const wanted of candidates) {
    const fuzzy = options.find((o) => normalizeText(o.name).includes(normalizeText(wanted)));
    if (fuzzy) return fuzzy.id;
  }

  return "";
}

function pickIterationOption(field, value) {
  if (!value || !field?.configuration?.iterations?.length) return "";
  const wanted = value.toLowerCase();
  const iterations = field.configuration.iterations;
  const exact = iterations.find((it) => it.title.toLowerCase() === wanted);
  if (exact) return exact.id;
  const fuzzy = iterations.find((it) => it.title.toLowerCase().includes(wanted));
  return fuzzy?.id || "";
}

async function updateProjectField(projectId, itemId, field, value, context = {}) {
  if (!value || !field) return;

  let fieldValue = null;

  if (field.__typename === "ProjectV2SingleSelectField") {
    const optionId = pickSingleSelectOption(field, String(value), context);
    if (!optionId) return;
    fieldValue = { singleSelectOptionId: optionId };
  } else if (field.__typename === "ProjectV2IterationField") {
    const iterationId = pickIterationOption(field, String(value));
    if (!iterationId) return;
    fieldValue = { iterationId };
  } else if (field.__typename === "ProjectV2Field") {
    if (field.dataType === "DATE") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
      fieldValue = { date: value };
    } else if (field.dataType === "NUMBER") {
      const n = Number(value);
      if (isNaN(n)) return;
      fieldValue = { number: n };
    } else {
      fieldValue = { text: String(value) };
    }
  }

  if (!fieldValue) return;

  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: field.id, value: fieldValue }
  );
}

async function findProjectItem(projectId, issueId) {
  let endCursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(
      `query($projectId: ID!, $endCursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $endCursor) {
              pageInfo { hasNextPage endCursor }
              nodes { id content { ... on Issue { id } } }
            }
          }
        }
      }`,
      { projectId, endCursor }
    );
    const nodes = data.node?.items?.nodes || [];
    const found = nodes.find((item) => item.content?.id === issueId);
    if (found?.id) return found.id;

    hasNextPage = Boolean(data.node?.items?.pageInfo?.hasNextPage);
    endCursor = data.node?.items?.pageInfo?.endCursor || null;
  }

  return null;
}

async function addProjectItem(projectId, issueId) {
  const data = await graphql(
    `mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } } }`,
    { projectId, contentId: issueId }
  );
  return data.addProjectV2ItemById.item.id;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function readConfig() {
  try {
    const content = await fs.readFile(configPath, "utf8");
    return JSON.parse(content);
  } catch {
    return { default: { fieldMap: {}, defaults: {} } };
  }
}

async function resolveLabelsFromRepoConfig(repoConfig) {
  const catalog = await loadLabelsCatalog({
    cardsRoot,
    repoConfig,
    projectLocale: await detectProjectLocale(),
  });
  labelsCatalogByName = new Map(catalog.specs.map((spec) => [spec.name, spec]));
  return catalog.names;
}

async function detectProjectLocale() {
  try {
    const raw = await fs.readFile(projectYmlPath, "utf8");
    const match = raw.match(/^\s*locale\s*:\s*([^\s#]+)\s*$/m);
    if (match?.[1]) return match[1];
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Dry-run table output
// ---------------------------------------------------------------------------

export function printDryRunTable(cards, edges) {
  log("");
  log("=== DRY-RUN REPORT ===");
  log("");

  const header = "| Card ID                | Type     | Action | Parent              | Categories              |";
  const sep =    "|------------------------|----------|--------|---------------------|-------------------------|";
  log(header);
  log(sep);

  for (const card of cards) {
    const id = card.cardId.padEnd(22);
    const type = (card.type || "Story").padEnd(8);
    const action = "CREATE ".padEnd(6);
    const parent = (card.parent || "—").padEnd(19);
    const cats = (card.categories || []).join(", ").slice(0, 23).padEnd(23);
    log(`| ${id} | ${type} | ${action} | ${parent} | ${cats} |`);
  }

  log("");
  log(`Total cards: ${cards.length}`);
  log(`Total parent-child links: ${edges.length}`);

  if (edges.length) {
    log("");
    log("Hierarchy:");
    for (const edge of edges) {
      log(`  ${edge.parentCardId} -> ${edge.childCardId}`);
    }
  }

  log("");
  log("=== END DRY-RUN ===");
}

// ---------------------------------------------------------------------------
// Forward sync (Markdown -> GitHub)
// ---------------------------------------------------------------------------

async function runForwardSync() {
  const config = await readConfig();
  let repoConfig = resolveRepoConfig(config, repositorySlug);
  const management = await resolveManagementConfig(repoConfig);
  const backend = String(management.backend || "github").toLowerCase();

  log(`Dry-run: ${dryRun ? "yes" : "no"}`);
  log(`Direction: forward`);
  log(`Backend: ${backend}`);

  if (backend === "jira") {
    await runForwardSyncJira(repoConfig, management);
    return;
  }

  if (backend === "azure-devops" || backend === "azure") {
    await runForwardSyncAzure(repoConfig, management);
    return;
  }

  if (backend === "linear") {
    await runForwardSyncLinear(repoConfig, management);
    return;
  }

  if (backend === "gitlab") {
    await runForwardSyncGitLab(repoConfig, management);
    return;
  }

  if (backend === "github") {
    if (!dryRun) {
      if (!repoOwner || repoOwner === "unknown") {
        throw new Error("GITHUB_REPOSITORY not set. Expected: owner/repo");
      }
      if (!token) {
        throw new Error("Token missing. Set GITHUB_TOKEN or PROJECT_SYNC_TOKEN");
      }
    }

    log(`Repository: ${repoOwner}/${repoName}`);
    log(`Token source: ${tokenSource}`);
    warnIfGhCliFallback();
  }

  const defaults = repoConfig.defaults || {};
  const fieldMap = repoConfig.fieldMap || {};

  let projectOwner = process.env.PROJECT_OWNER || repoConfig.projectOwner || repoOwner;
  let projectNumber =
    Number(process.env.PROJECT_NUMBER || "0") || Number(repoConfig.projectNumber || "0");
  let projectDiscovery = { reason: null, candidates: [] };

  if (backend === "github" && token && repoOwner !== "unknown" && projectNumber <= 0) {
    try {
      const discovery = await discoverGitHubProjectNumber({
        token,
        owner: repoOwner,
        repoName,
        repoConfig,
        configPath,
        repositorySlug,
        persist: !dryRun,
      });
      projectDiscovery = discovery;
      if (discovery.discovered) {
        if (dryRun) {
          log(
            `Auto-discovered GitHub Project #${discovery.projectNumber}: "${discovery.projectTitle}" (dry-run — not saved to projects-map.json)`
          );
          projectOwner = process.env.PROJECT_OWNER || discovery.projectOwner || repoOwner;
          projectNumber = discovery.projectNumber;
        } else {
          log(`Auto-discovered GitHub Project #${discovery.projectNumber}: "${discovery.projectTitle}"`);
          const freshConfig = await readConfig();
          repoConfig = resolveRepoConfig(freshConfig, repositorySlug);
          projectOwner = process.env.PROJECT_OWNER || repoConfig.projectOwner || repoOwner;
          projectNumber =
            Number(process.env.PROJECT_NUMBER || "0") || Number(repoConfig.projectNumber || "0");
        }
      } else if (discovery.reason === "ambiguous") {
        log("Multiple GitHub Projects found — set projectNumber in projects-map.json");
        for (const c of discovery.candidates || []) {
          log(`  candidate: #${c.number} ${c.title}`);
        }
      }
    } catch (error) {
      log(`Project auto-discovery skipped: ${error.message}`);
    }
  }

  // Override createMissingLabels from config if set
  if (repoConfig.createMissingLabels !== undefined) {
    createMissingLabels = Boolean(repoConfig.createMissingLabels);
  }

  // Pre-provision all labels from config (ensures they exist before card sync)
  const configLabels = await resolveLabelsFromRepoConfig(repoConfig);
  if (configLabels.length && createMissingLabels && !dryRun && token) {
    log(`Provisioning ${configLabels.length} labels...`);
    let created = 0;
    for (const labelName of configLabels) {
      const id = await getLabelId(repoOwner, repoName, labelName, true);
      if (id) created++;
    }
    log(`Labels ready (${created} verified/created).`);
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
    if (card) {
      cards.push(card);
    } else {
      log(`SKIP (no frontmatter/card_id): ${relative}`);
    }
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

  const cardsToSync = onlyIds?.length ? expandCardIdsWithParents(syncableCards, onlyIds) : syncableCards;
  if (onlyIds?.length) {
    log(`Incremental sync: ${onlyIds.length} target(s) → ${cardsToSync.length} card(s) including parents`);
  }

  log(`Valid cards: ${cardsToSync.length}${onlyIds?.length ? ` (of ${syncableCards.length} syncable)` : ""}`);

  const edges = filterEdgesForCards(buildEdges(cardsToSync), cardsToSync.map((c) => c.cardId));
  log(`Parent-child links: ${edges.length}`);

  if (dryRun && !token) {
    printDryRunTable(cardsToSync, edges);
    return;
  }

  const issueByCardId = new Map();
  const issueExistedByCardId = new Map();
  const actions = [];
  const preloadedIssueMap = token ? await loadIssueMapByCardId(repoOwner, repoName) : new Map();
  const repositoryId = dryRun ? null : await getRepositoryNodeId(repoOwner, repoName);

  await mapWithConcurrency(cardsToSync, syncConcurrency, async (card) => {
    const issueTitle = buildIssueTitle(card);
    const issueBody = buildIssueBody(card);

    const existing = preloadedIssueMap.get(card.cardId) || null;

    if (dryRun) {
      actions.push({ action: existing ? "UPDATE" : "CREATE", cardId: card.cardId, title: issueTitle });
      issueByCardId.set(card.cardId, existing || { id: `DRY-${card.cardId}`, number: 0 });
      issueExistedByCardId.set(card.cardId, Boolean(existing));
      return;
    }

    const issue = existing
      ? await updateIssue(existing.id, issueTitle, issueBody)
      : await createIssue(repositoryId, issueTitle, issueBody);

    issueByCardId.set(card.cardId, issue);
    issueExistedByCardId.set(card.cardId, Boolean(existing));
    actions.push({
      action: existing ? "UPDATED" : "CREATED",
      cardId: card.cardId,
      number: issue.number,
      url: issue.url,
    });

    // Set labels from categories
    if (card.categories.length) {
      try {
        await setIssueLabels(issue.id, repoOwner, repoName, card.categories);
      } catch (e) {
        actions.push({ action: "LABELS_FAILED", cardId: card.cardId, reason: e.message });
      }
    }
  });

  if (!dryRun && issueByCardId.size) {
    try {
      const fullIssueMap = await loadIssueMapByCardId(repoOwner, repoName);
      for (const [cardId, issue] of fullIssueMap) {
        if (!issueByCardId.has(cardId)) issueByCardId.set(cardId, issue);
      }
    } catch (e) {
      log(`Could not load full issue map for link enrichment: ${e.message}`);
    }

    const linkContext = { issueByCardId, owner: repoOwner, name: repoName };
    await mapWithConcurrency(cardsToSync, syncConcurrency, async (card) => {
      const issue = issueByCardId.get(card.cardId);
      if (!issue?.id) return;
      try {
        const enrichedBody = buildIssueBody(card, linkContext);
        await updateIssue(issue.id, buildIssueTitle(card), enrichedBody);
        actions.push({ action: "BODY_ENRICHED", cardId: card.cardId, number: issue.number });
      } catch (e) {
        actions.push({ action: "BODY_ENRICH_FAILED", cardId: card.cardId, reason: e.message });
      }
    });
  }

  // Link sub-issues
  for (const edge of edges) {
    const parentIssue = issueByCardId.get(edge.parentCardId);
    const childIssue = issueByCardId.get(edge.childCardId);
    if (!parentIssue || !childIssue) continue;

    if (!dryRun) {
      try {
        await linkAsSubIssue(parentIssue.id, childIssue.id);
        actions.push({ action: "LINKED", parent: parentIssue.number, child: childIssue.number });
      } catch (e) {
        actions.push({ action: "LINK_FAILED", parent: edge.parentCardId, child: edge.childCardId, reason: e.message });
      }
    }
  }

  // Project field updates
  let project = null;
  if (projectNumber > 0 && !dryRun) {
    project = await getProject(projectOwner, projectNumber);
    if (!project) {
      log(`Project not found: owner=${projectOwner} number=${projectNumber}`);
    } else {
      log(`Project found: owner=${projectOwner} number=${projectNumber}`);
      await ensureStatusFieldOptions(project, repoConfig);
      await ensureKitFieldColors(project, repoConfig);
      await ensureKitProjectViews(project);
      await ensureSprintField(project, repoConfig);
      project = await getProject(projectOwner, projectNumber);
    }
  }

  if (!project && !dryRun) {
    if (projectNumber > 0) {
      log(`Project #${projectNumber} not found — check projectOwner/projectNumber in config.`);
    } else if (repoConfig.autoCreateProject !== false) {
      if (projectDiscovery.reason === "ambiguous") {
        log("Auto-create skipped: multiple GitHub Projects found — set projectNumber in projects-map.json");
        for (const c of projectDiscovery.candidates || []) {
          log(`  candidate: #${c.number} ${c.title}`);
        }
        log("Run: npm run cards:doctor");
      } else {
        try {
          const created = await autoCreateProject(projectOwner, repoConfig);
          project = await getProject(projectOwner, created.number);
        } catch (e) {
          log(`Auto-create project failed: ${e.message}`);
        }
      }
    }
  }

  if (project && !dryRun) {
    try {
      await ensureProjectRepositoryLink(project, repositoryId, repositorySlug);
    } catch (e) {
      actions.push({ action: "PROJECT_LINK_FAILED", reason: e.message });
      log(`  WARN: Could not link project to repository: ${e.message}`);
    }

    const fStatus = resolveProjectField(project, "status", fieldMap);
    const fType = resolveProjectField(project, "type", fieldMap);
    const fPriority = resolveProjectField(project, "priority", fieldMap);
    const fSprint = resolveProjectField(project, "sprint", fieldMap);
    const fStoryPoints = resolveProjectField(project, "storyPoints", fieldMap);
    const fReporter = resolveProjectField(project, "reporter", fieldMap);
    const fParent = resolveProjectField(project, "parent", fieldMap);
    const fDueDate = resolveProjectField(project, "dueDate", fieldMap);

    await mapWithConcurrency(cardsToSync, syncConcurrency, async (card) => {
      const issue = issueByCardId.get(card.cardId);
      if (!issue) return;

      let itemId;
      try {
        itemId = await findProjectItem(project.id, issue.id);
        if (!itemId) {
          itemId = await addProjectItem(project.id, issue.id);
          actions.push({ action: "ADDED_TO_PROJECT", cardId: card.cardId });
        }
      } catch (e) {
        actions.push({ action: "PROJECT_ADD_FAILED", cardId: card.cardId, reason: e.message });
        return;
      }

      try {
        // Safe status behavior:
        // - If card.status is provided: always apply it.
        // - If card.status is missing:
        //   - new issue => apply defaults.status (or Backlog)
        //   - existing issue => preserve manual status (do not overwrite)
        const existed = issueExistedByCardId.get(card.cardId) === true;
        const desiredStatus =
          card.status ??
          (existed ? null : (defaults.status || "Backlog"));

        await updateProjectField(project.id, itemId, fStatus, desiredStatus, { fieldKey: "status", repoConfig });
        await updateProjectField(project.id, itemId, fType, card.type, { fieldKey: "type", repoConfig });
        await updateProjectField(project.id, itemId, fPriority, card.priority, { fieldKey: "priority", repoConfig });
        await updateProjectField(project.id, itemId, fSprint, card.sprint);
        await updateProjectField(project.id, itemId, fStoryPoints, card.storyPoints);
        await updateProjectField(project.id, itemId, fReporter, card.reporter);
        await updateProjectField(
          project.id,
          itemId,
          fParent,
          formatParentFieldValue(card.parent, issueByCardId, repoOwner, repoName)
        );
        await updateProjectField(project.id, itemId, fDueDate, card.dueDate);
      } catch (e) {
        actions.push({ action: "FIELD_UPDATE_FAILED", cardId: card.cardId, reason: e.message });
      }
    });
  }

  // Print summary
  if (dryRun) {
    printDryRunTable(cardsToSync, edges);
  } else {
    log("");
    log("=== SYNC COMPLETE ===");
    for (const a of actions) {
      log(JSON.stringify(a));
    }

    try {
      const summaryPath = await writeSyncSummary({
        workspaceRoot,
        plansCardsDir: hyperionPaths.plansCardsDir,
        repositorySlug,
        projectOwner,
        projectNumber: projectNumber > 0 ? projectNumber : null,
        actions,
        cardCount: cardsToSync.length,
        incrementalIds: onlyIds,
      });
      log(`Summary written: ${path.relative(workspaceRoot, summaryPath)}`);
    } catch (error) {
      log(`Could not write sync summary: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reverse sync (Backend -> Markdown)
// ---------------------------------------------------------------------------

function parseParentCardIdFromProjectField(text) {
  const m = String(text || "").match(/\(([A-Z0-9][A-Z0-9_-]*)\)\s*$/i);
  return m ? m[1] : null;
}

function readProjectFieldValueNode(fieldValueNode) {
  if (!fieldValueNode) return null;
  if (fieldValueNode.name != null && fieldValueNode.name !== "") return fieldValueNode.name;
  if (fieldValueNode.title != null && fieldValueNode.title !== "") return fieldValueNode.title;
  if (fieldValueNode.number != null && fieldValueNode.number !== "") return fieldValueNode.number;
  if (fieldValueNode.text != null && fieldValueNode.text !== "") return fieldValueNode.text;
  if (fieldValueNode.date != null && fieldValueNode.date !== "") return fieldValueNode.date;
  return null;
}

function readProjectFieldsFromItem(item, project, fieldMap) {
  const out = {};
  const idToKey = {};
  for (const key of ["status", "type", "priority", "sprint", "storyPoints", "reporter", "parent", "dueDate"]) {
    const field = resolveProjectField(project, key, fieldMap);
    if (field?.id) idToKey[field.id] = key;
  }

  for (const fv of item.fieldValues?.nodes || []) {
    const fieldId = fv.field?.id;
    const key = idToKey[fieldId];
    if (!key) continue;
    out[key] = readProjectFieldValueNode(fv);
  }
  return out;
}

async function loadProjectFieldValuesByIssueNumber(projectOwner, projectNumber, repoConfig) {
  const project = await getProject(projectOwner, projectNumber);
  if (!project?.id) {
    return { project: null, byIssueNumber: new Map() };
  }

  const fieldMap = repoConfig.fieldMap || {};
  const byIssueNumber = new Map();
  let endCursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(
      `query($projectId: ID!, $endCursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $endCursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                content { ... on Issue { number } }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      field { ... on ProjectV2SingleSelectField { id name } ... on ProjectV2Field { id name } }
                      name
                    }
                    ... on ProjectV2ItemFieldIterationValue {
                      field { ... on ProjectV2IterationField { id name } }
                      title
                    }
                    ... on ProjectV2ItemFieldNumberValue {
                      field { ... on ProjectV2Field { id name } }
                      number
                    }
                    ... on ProjectV2ItemFieldTextValue {
                      field { ... on ProjectV2Field { id name } }
                      text
                    }
                    ... on ProjectV2ItemFieldDateValue {
                      field { ... on ProjectV2Field { id name } }
                      date
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { projectId: project.id, endCursor }
    );

    for (const item of data.node?.items?.nodes || []) {
      const issueNumber = item.content?.number;
      if (!issueNumber) continue;
      byIssueNumber.set(issueNumber, readProjectFieldsFromItem(item, project, fieldMap));
    }

    hasNextPage = Boolean(data.node?.items?.pageInfo?.hasNextPage);
    endCursor = data.node?.items?.pageInfo?.endCursor || null;
  }

  return { project, byIssueNumber };
}

function buildRemoteFrontmatterUpdates(projectFields, issue, repoConfig) {
  const updates = {};

  if (projectFields.status != null) {
    updates.status = canonicalizeRemoteOption("status", projectFields.status, repoConfig);
  }
  if (projectFields.type != null) {
    updates.type = canonicalizeRemoteOption("type", projectFields.type, repoConfig);
  }
  if (projectFields.priority != null) {
    updates.priority = canonicalizeRemoteOption("priority", projectFields.priority, repoConfig);
  }
  if (projectFields.sprint != null) {
    updates.sprint = String(projectFields.sprint).trim() || null;
  }
  if (projectFields.storyPoints != null && projectFields.storyPoints !== "") {
    updates.story_points = Number(projectFields.storyPoints);
  }
  if (projectFields.reporter != null) {
    updates.reporter = String(projectFields.reporter).trim() || null;
  }
  if (projectFields.parent != null) {
    updates.parent = parseParentCardIdFromProjectField(projectFields.parent);
  }
  if (projectFields.dueDate != null) {
    updates.due_date = String(projectFields.dueDate).trim() || null;
  }
  if (Array.isArray(issue.labels) && issue.labels.length) {
    updates.categories = issue.labels;
  }

  return updates;
}

export async function applyReverseCardFileUpdate({
  sourceFile,
  cardId,
  remoteUpdates = {},
  converted = null,
  logLabel = "",
}) {
  if (!sourceFile) return { kind: "skipped", reason: "no_source_file" };

  if (isKitSampleRemoteArtifact({ cardId, sourceFile })) {
    return { kind: "skipped_sample" };
  }

  const updates = { ...remoteUpdates };
  if (converted) {
    const fromMd = frontmatterUpdatesFromConvertedMarkdown(converted);
    for (const [key, value] of Object.entries(fromMd)) {
      if (updates[key] === undefined && value !== undefined) updates[key] = value;
    }
  }

  const local = await readLocalCardFromSourceFile(sourceFile, {
    workspaceRoot,
    kitRootRel: hyperionPaths.kitRootRel,
  });

  if (local) {
    if (!frontmatterDiffers(local.content, updates)) {
      return { kind: "unchanged", path: local.relativeFile };
    }

    const patched = patchCardFrontmatter(local.content, updates);
    if (!patched) {
      log(`SKIP (invalid frontmatter): ${local.relativeFile}${logLabel}`);
      return { kind: "skipped", reason: "invalid_frontmatter" };
    }

    if (dryRun) {
      log(`Would patch frontmatter: ${local.relativeFile}${logLabel}`);
      return { kind: "dry_run_patch", path: local.relativeFile };
    }

    await fs.mkdir(path.dirname(local.absolutePath), { recursive: true });
    await fs.writeFile(local.absolutePath, patched, "utf8");
    log(`Patched: ${local.relativeFile}${logLabel}`);
    return { kind: "patched", path: local.relativeFile };
  }

  if (!converted) {
    log(`SKIP (no local card, invalid metadata): ${sourceFile}${logLabel}`);
    return { kind: "skipped", reason: "no_local_no_convert" };
  }

  const parsed = parseFrontmatter(converted.markdown);
  if (!parsed) return { kind: "skipped", reason: "invalid_convert" };

  const mergedMeta = {
    ...parsed.meta,
    ...updates,
    card_id: parsed.meta.card_id || cardId,
  };
  const markdown = buildCardMarkdownFromMeta(mergedMeta, parsed.body);
  const targetPath = path.join(workspaceRoot, converted.sourceFile);

  if (dryRun) {
    log(`Would create: ${converted.sourceFile}${logLabel}`);
    return { kind: "dry_run_create" };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, markdown, "utf8");
  log(`Created: ${converted.sourceFile}${logLabel}`);
  return { kind: "created", path: converted.sourceFile };
}

export function countReverseWrite(result) {
  return result.kind === "patched" || result.kind === "created" ? 1 : 0;
}

async function runReverseSyncGitHub(repoConfig) {
  if (!repoOwner || repoOwner === "unknown") {
    throw new Error("GITHUB_REPOSITORY not set.");
  }
  if (!token) {
    throw new Error("Token missing.");
  }

  log(`Repository: ${repoOwner}/${repoName}`);
  log(`Dry-run: ${dryRun ? "yes" : "no"}`);
  log("Direction: reverse (GitHub -> Markdown)");
  warnIfGhCliFallback();

  const issueMap = await loadIssueMapByCardId(repoOwner, repoName);
  const issues = [...issueMap.values()];

  if (!issues.length) {
    log("No issues with CARD_ID found.");
    return;
  }

  log(`Issues mapped: ${issues.length}`);

  let projectOwner = process.env.PROJECT_OWNER || repoConfig.projectOwner || repoOwner;
  let projectNumber =
    Number(process.env.PROJECT_NUMBER || "0") || Number(repoConfig.projectNumber || "0");

  let projectFieldsByIssueNumber = new Map();
  if (projectNumber > 0) {
    const loaded = await loadProjectFieldValuesByIssueNumber(projectOwner, projectNumber, repoConfig);
    projectFieldsByIssueNumber = loaded.byIssueNumber;
    if (loaded.project) {
      log(`Project fields loaded: owner=${projectOwner} number=${projectNumber} (${projectFieldsByIssueNumber.size} item(s))`);
    } else {
      log(`Project #${projectNumber} not found — reverse will use issue metadata only.`);
    }
  } else {
    log("No projectNumber configured — reverse will use issue metadata only (no board fields).");
    if (String(process.env.CARDS_CI_REQUIRE_PROJECT || "").toLowerCase() === "true") {
      throw new Error(
        "projectNumber required for CI reverse (board pull). Set it in projects-map.json — run: npm run cards:doctor"
      );
    }
  }

  let written = 0;
  let skipped = 0;
  let skippedSamples = 0;
  let unchanged = 0;

  for (const issue of issues) {
    if (!issue?.number) continue;

    const syncMeta = parseSyncMetadataFromDescription(issue.body || "");
    const sourceFile = syncMeta?.meta?.SOURCE_FILE || parseSourceFileFromIssueBody(issue.body);
    const cardId = syncMeta?.meta?.CARD_ID || parseCardIdFromIssueBody(issue.body);

    if (!sourceFile) continue;

    if (isKitSampleRemoteArtifact({ cardId, sourceFile })) {
      skippedSamples += 1;
      log(`Skipping kit sample issue #${issue.number} (${cardId || sourceFile})`);
      continue;
    }

    const projectFields = projectFieldsByIssueNumber.get(issue.number) || {};
    const remoteUpdates = buildRemoteFrontmatterUpdates(projectFields, issue, repoConfig);
    const syncAt = remoteBoardSyncAt(issue);
    if (syncAt) remoteUpdates.board_sync_at = syncAt;

    const converted = remoteIssueToCardMarkdown({
      title: issue.title,
      description: issue.body || "",
      labels: issue.labels,
      statusOverride: remoteUpdates.status,
    });

    const result = await applyReverseCardFileUpdate({
      sourceFile,
      cardId,
      remoteUpdates,
      converted,
      logLabel: ` (issue #${issue.number})`,
    });

    if (result.kind === "skipped_sample") {
      skippedSamples += 1;
      log(`Skipping kit sample issue #${issue.number} (${cardId || sourceFile})`);
      continue;
    }
    if (result.kind === "unchanged") unchanged += 1;
    else if (result.kind === "skipped") skipped += 1;
    else written += countReverseWrite(result);
  }

  if (skippedSamples > 0) {
    log(`Skipped ${skippedSamples} kit sample issue(s) on reverse sync.`);
  }
  if (unchanged > 0) {
    log(`Unchanged: ${unchanged} card(s) (frontmatter already matches board).`);
  }
  if (!dryRun) log(`GitHub reverse sync wrote: ${written} file(s)`);
  if (skipped > 0) log(`Skipped: ${skipped} issue(s).`);
}

async function runReverseSync() {
  const config = await readConfig();
  const repoConfig = resolveRepoConfig(config, repositorySlug);
  const management = await resolveManagementConfig(repoConfig);
  const backend = String(management.backend || "github").toLowerCase();

  if (backend === "jira") {
    await runReverseSyncJira(repoConfig, management);
    return;
  }

  if (backend === "azure-devops" || backend === "azure") {
    await runReverseSyncAzure(repoConfig, management);
    return;
  }

  if (backend === "gitlab") {
    await runReverseSyncGitLab(repoConfig, management);
    return;
  }

  if (backend === "linear") {
    await runReverseSyncLinear(repoConfig, management);
    return;
  }

  // Default: GitHub reverse sync
  await runReverseSyncGitHub(repoConfig);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Whether to interrupt a live (non-dry-run) sync with a confirmation prompt
 * before writing anything. Only fires for a human at an interactive
 * terminal — CI (ci-sync.mjs, hyperion-sync-cards.yml) has no TTY, so this
 * is always false there regardless of dry-run state, and watch.mjs's live
 * mode passes CARDS_SYNC_YES itself (the user already opted in once, at
 * the watcher level, by setting CARDS_WATCH_LIVE).
 */
export function shouldPromptBeforeLiveSync({
  dryRun: isDryRun,
  isTTY,
  argv = process.argv,
  env = process.env,
} = {}) {
  if (isDryRun) return false;
  if (!isTTY) return false;
  if (argv.includes("--yes")) return false;
  if (String(env.CARDS_SYNC_YES || "").toLowerCase() === "true") return false;
  return true;
}

async function confirmLiveSync() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `[cards-sync] This will write to your LIVE board (no --dry-run). Type "yes" to continue: `
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function main() {
  if (shouldPromptBeforeLiveSync({ dryRun, isTTY: process.stdin.isTTY })) {
    const confirmed = await confirmLiveSync();
    if (!confirmed) {
      log("Aborted — nothing written. Pass --yes (or CARDS_SYNC_YES=true) to skip this prompt.");
      process.exitCode = 1;
      return;
    }
  }

  if (syncDirection === "reverse") {
    await runReverseSync();
  } else {
    await runForwardSync();
  }
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentFilePath = fileURLToPath(import.meta.url);
const isDirectRun = directRunPath === currentFilePath;

const CONFIG_ERROR_PATTERN = /backend requires .+\(env or config\)\.?$/;

if (isDirectRun) {
  main().catch((error) => {
    const message = String(error?.message || error);
    if (CONFIG_ERROR_PATTERN.test(message)) {
      // A missing/misconfigured backend is a setup problem, not a crash —
      // show the actionable message only, keep the stack for --verbose.
      console.error(`[cards-sync] ${message}`);
      if (process.argv.includes("--verbose")) console.error(error);
    } else {
      console.error("[cards-sync] FATAL ERROR");
      console.error(error);
    }
    process.exit(1);
  });
}

export {
  parseFrontmatter,
  parseCardFile,
  parseSubIssueIds,
  extractCardIdFromReference,
  formatCardReference,
  beautifyCardBodyForDisplay,
  enrichBodySubIssues,
  buildIssueBody,
  buildEdges,
  normalizeText,
  resolveMappedOptionValue,
  canonicalizeRemoteOption,
  buildOptionCandidates,
  pickSingleSelectOption,
  pickIterationOption,
  resolveSprintFieldConfig,
  pickJiraTransition,
  buildJiraDescription,
  parseSyncMetadataFromDescription,
  parseIssueSummaryTypeTitle,
  jiraIssueToCardMarkdown,
  remoteIssueToCardMarkdown,
  resolveMappedStatus,
  resolveGitLabStatusAction,
  buildAzureWiqlForCardId,
  buildAzureWiqlForAllCardIds,
  jiraRequest,
  graphql,
  DEFAULT_STATUS_OPTIONS,
  patchCardFrontmatter,
  buildRemoteFrontmatterUpdates,
  resolveHyperionStatusFromRemote,
  canonicalizeLinearState,
  inverseStatusMap,
  getLabelId,
};
