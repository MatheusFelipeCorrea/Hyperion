import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
} from "./lib.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const hyperionPaths = resolveHyperionPaths(process.cwd());
const workspaceRoot = hyperionPaths.workspaceRoot;
const cardsRoot = hyperionPaths.cardsRoot;
const cardsPrefix = hyperionPaths.cardsPrefix;
const configPath = path.join(cardsRoot, "config", "projects-map.json");
const projectYmlPath = hyperionPaths.projectYmlPath;

const argDryRun = process.argv.includes("--dry-run");
const argReverse = process.argv.includes("--reverse");
const argForward = process.argv.includes("--forward");
const envDryRun = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const dryRun = argDryRun || envDryRun;
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

function log(message) {
  console.log(`[cards-sync] ${message}`);
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
// YAML Frontmatter Parser (lightweight, no dependencies)
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const yamlBlock = match[1];
  const body = match[2];
  const meta = {};

  let currentKey = null;
  let currentArray = null;

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trimEnd();

    if (/^\s*-\s+/.test(trimmed) && currentKey && currentArray !== null) {
      const value = trimmed.replace(/^\s*-\s+/, "").replace(/^["']|["']$/g, "").trim();
      if (value) currentArray.push(value);
      continue;
    }

    if (currentKey && currentArray !== null) {
      meta[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    const kvMatch = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    if (value === "") {
      currentKey = key;
      currentArray = [];
      continue;
    }

    if (value === "null") {
      meta[key] = null;
      continue;
    }

    // Inline array: [Frontend, Backend]
    const inlineArray = value.match(/^\[([^\]]*)\]$/);
    if (inlineArray) {
      meta[key] = inlineArray[1]
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }

    // Scalar value
    value = value.replace(/^["']|["']$/g, "");
    const num = Number(value);
    if (!isNaN(num) && value !== "") {
      meta[key] = num;
    } else {
      meta[key] = value;
    }
  }

  if (currentKey && currentArray !== null) {
    meta[currentKey] = currentArray;
  }

  return { meta, body };
}

// ---------------------------------------------------------------------------
// File listing
// ---------------------------------------------------------------------------

async function listMarkdownFiles(dir) {
  return listCardsMarkdownFiles(dir, { forSync: true });
}

// ---------------------------------------------------------------------------
// Card parsing — one card per file
// ---------------------------------------------------------------------------

function parseCardFile(content, relativeFile) {
  const parsed = parseFrontmatter(content);
  if (!parsed || !parsed.meta.card_id) {
    return null;
  }

  const { meta, body } = parsed;

  return {
    cardId: meta.card_id,
    title: meta.title || extractTitleFromBody(body),
    status: meta.status || null,
    type: meta.type || "Story",
    priority: meta.priority || null,
    sprint: meta.sprint || null,
    storyPoints: meta.story_points ?? null,
    reporter: meta.reporter || null,
    parent: meta.parent || null,
    dueDate: meta.due_date || null,
    boardSyncAt: meta.board_sync_at || null,
    categories: Array.isArray(meta.categories) ? meta.categories : [],
    body,
    relativeFile,
  };
}

function extractTitleFromBody(body) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled";
}

// ---------------------------------------------------------------------------
// Sub-issues detection from body
// ---------------------------------------------------------------------------

function splitBodyLines(body) {
  return String(body || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
}

function extractCardIdFromReference(text) {
  const value = String(text || "").trim();
  const linkMatch = value.match(/^\[([A-Z0-9][A-Z0-9_-]*)\s*(?:\(#\d+\))?\]/i);
  if (linkMatch) return linkMatch[1];
  const plainMatch = value.match(/^([A-Z0-9][A-Z0-9_-]*)/i);
  return plainMatch ? plainMatch[1] : value;
}

function parseSubIssueIds(body) {
  const results = [];
  const lines = splitBodyLines(body);
  let inSection = false;

  for (const line of lines) {
    if (/^##\s+.*[Ss]ub-issues/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (!bullet) continue;
    const id = extractCardIdFromReference(bullet[1]);
    if (id) results.push(id);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Edge building (parent-child relationships)
// ---------------------------------------------------------------------------

function buildEdges(cards) {
  const byCardId = new Map(cards.map((c) => [c.cardId, c]));
  const edges = [];
  const seen = new Set();

  const addEdge = (parentId, childId) => {
    if (!parentId || !childId || parentId === childId) return;
    const key = `${parentId}=>${childId}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ parentCardId: parentId, childCardId: childId });
  };

  for (const card of cards) {
    if (card.parent && byCardId.has(card.parent)) {
      addEdge(card.parent, card.cardId);
    }
  }

  for (const card of cards) {
    const subIds = parseSubIssueIds(card.body);
    for (const childId of subIds) {
      if (byCardId.has(childId)) {
        addEdge(card.cardId, childId);
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Issue title formatting
// ---------------------------------------------------------------------------

function buildIssueTitle(card) {
  const typeTag = card.type || "Story";
  const baseTitle = (card.title || "").replace(/^\[[^\]]+\]\s*/, "").trim();
  return `[${typeTag}] ${baseTitle || card.cardId}`;
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

function buildJiraDescription(card) {
  const lines = [];
  lines.push(card.body.trim());
  lines.push("");
  lines.push("---");
  lines.push("<!-- SYNC_METADATA — do not edit below this line -->");
  lines.push(`CARD_ID: ${card.cardId}`);
  lines.push(`SOURCE_FILE: ${card.relativeFile}`);
  lines.push(`TYPE: ${card.type || "Story"}`);
  lines.push(`STATUS: ${card.status ?? ""}`);
  lines.push(`PRIORITY: ${card.priority ?? ""}`);
  lines.push(`SPRINT: ${card.sprint ?? ""}`);
  lines.push(`STORY_POINTS: ${card.storyPoints ?? ""}`);
  lines.push(`REPORTER: ${card.reporter ?? ""}`);
  lines.push(`PARENT_CARD_ID: ${card.parent ?? ""}`);
  lines.push(`DUE_DATE: ${card.dueDate ?? ""}`);
  lines.push(`CATEGORIES: ${(card.categories || []).join(", ")}`);
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

function applyKitSampleFilter(cards, onlyIds) {
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

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const OPTION_ALIASES = {
  status: {
    Backlog: ["backlog"],
    "To do": ["to do", "todo", "a fazer"],
    "In progress": ["in progress", "em progresso"],
    "In tests": ["in tests", "em testes"],
    "In revision": ["in revision", "em revisao", "em revisão"],
    Done: ["done", "feito", "concluido", "concluído"],
    "Functional Refinement": ["functional refinement", "refinamento funcional"],
    "Technical Refinement": ["technical refinement", "refinamento tecnico", "refinamento técnico"],
  },
  type: {
    Epic: ["epic", "epico", "épico"],
    Feature: ["feature", "feat", "funcionalidade"],
    Story: ["story", "historia", "história", "user story"],
    Task: ["task", "tarefa"],
    Subtask: ["subtask", "sub-task", "sub tarefa", "subtarefa"],
    Bug: ["bug", "defect", "erro"],
  },
  priority: {
    Highest: ["highest", "critical", "critico", "crítico", "urgente", "urgent"],
    High: ["high", "alto", "alta"],
    Medium: ["medium", "medio", "médio", "normal"],
    Low: ["low", "baixo", "baixa"],
  },
};

function resolveMappedOptionValue(fieldKey, value, repoConfig) {
  if (!fieldKey || value === null || value === undefined) return value;
  const raw = String(value);
  const locale = repoConfig?.locale || "en";
  const directMap = repoConfig?.optionMap?.[fieldKey] || {};
  const localeMap = repoConfig?.optionMapByLocale?.[locale]?.[fieldKey] || {};
  return localeMap[raw] ?? directMap[raw] ?? value;
}

/** Inverse of resolveMappedOptionValue — localized Project option → canonical YAML value. */
function canonicalizeRemoteOption(fieldKey, remoteValue, repoConfig) {
  if (remoteValue === null || remoteValue === undefined) return null;
  const raw = String(remoteValue).trim();
  if (!raw) return null;

  const locale = repoConfig?.locale || "en";
  const directMap = repoConfig?.optionMap?.[fieldKey] || {};
  const localeMap = repoConfig?.optionMapByLocale?.[locale]?.[fieldKey] || {};

  for (const [canonical, localized] of Object.entries(localeMap)) {
    if (normalizeText(localized) === normalizeText(raw)) return canonical;
    if (normalizeText(canonical) === normalizeText(raw)) return canonical;
  }
  for (const [canonical, mapped] of Object.entries(directMap)) {
    if (normalizeText(mapped) === normalizeText(raw)) return canonical;
    if (normalizeText(canonical) === normalizeText(raw)) return canonical;
  }

  const aliasesByField = OPTION_ALIASES[fieldKey] || {};
  const normRaw = normalizeText(raw);
  for (const [canonical, aliases] of Object.entries(aliasesByField)) {
    if (normalizeText(canonical) === normRaw) return canonical;
    if (aliases.some((alias) => normalizeText(alias) === normRaw)) return canonical;
  }

  return raw;
}

function buildOptionCandidates(fieldKey, value, repoConfig) {
  const mapped = resolveMappedOptionValue(fieldKey, value, repoConfig);
  const candidates = [String(mapped), String(value)];
  const aliasesByField = OPTION_ALIASES[fieldKey] || {};
  const normalizedInput = normalizeText(mapped);

  for (const [canonical, aliases] of Object.entries(aliasesByField)) {
    const normalizedAliases = [canonical, ...aliases].map(normalizeText);
    if (normalizedAliases.includes(normalizedInput)) {
      candidates.push(canonical, ...aliases);
      break;
    }
  }

  // de-duplicate preserving order
  const seen = new Set();
  return candidates.filter((c) => {
    const key = normalizeText(c);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function printDryRunTable(cards, edges) {
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
  }

  const defaults = repoConfig.defaults || {};
  const fieldMap = repoConfig.fieldMap || {};

  let projectOwner = process.env.PROJECT_OWNER || repoConfig.projectOwner || repoOwner;
  let projectNumber =
    Number(process.env.PROJECT_NUMBER || "0") || Number(repoConfig.projectNumber || "0");

  if (backend === "github" && token && repoOwner !== "unknown" && projectNumber <= 0) {
    try {
      const discovery = await discoverGitHubProjectNumber({
        token,
        owner: repoOwner,
        repoName,
        repoConfig,
        configPath,
        repositorySlug,
      });
      if (discovery.discovered) {
        log(`Auto-discovered GitHub Project #${discovery.projectNumber}: "${discovery.projectTitle}"`);
        const freshConfig = await readConfig();
        repoConfig = resolveRepoConfig(freshConfig, repositorySlug);
        projectOwner = process.env.PROJECT_OWNER || repoConfig.projectOwner || repoOwner;
        projectNumber =
          Number(process.env.PROJECT_NUMBER || "0") || Number(repoConfig.projectNumber || "0");
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
    log(`No card files found in ${cardsPrefix}/`);
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

  for (const card of cardsToSync) {
    const issueTitle = buildIssueTitle(card);
    const issueBody = buildIssueBody(card);

    const existing = preloadedIssueMap.get(card.cardId) || null;

    if (dryRun) {
      actions.push({ action: existing ? "UPDATE" : "CREATE", cardId: card.cardId, title: issueTitle });
      issueByCardId.set(card.cardId, existing || { id: `DRY-${card.cardId}`, number: 0 });
      issueExistedByCardId.set(card.cardId, Boolean(existing));
      continue;
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
  }

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
    for (const card of cardsToSync) {
      const issue = issueByCardId.get(card.cardId);
      if (!issue?.id) continue;
      try {
        const enrichedBody = buildIssueBody(card, linkContext);
        await updateIssue(issue.id, buildIssueTitle(card), enrichedBody);
        actions.push({ action: "BODY_ENRICHED", cardId: card.cardId, number: issue.number });
      } catch (e) {
        actions.push({ action: "BODY_ENRICH_FAILED", cardId: card.cardId, reason: e.message });
      }
    }
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
      try {
        const created = await autoCreateProject(projectOwner, repoConfig);
        project = await getProject(projectOwner, created.number);
      } catch (e) {
        log(`Auto-create project failed: ${e.message}`);
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

    for (const card of cardsToSync) {
      const issue = issueByCardId.get(card.cardId);
      if (!issue) continue;

      let itemId;
      try {
        itemId = await findProjectItem(project.id, issue.id);
        if (!itemId) {
          itemId = await addProjectItem(project.id, issue.id);
          actions.push({ action: "ADDED_TO_PROJECT", cardId: card.cardId });
        }
      } catch (e) {
        actions.push({ action: "PROJECT_ADD_FAILED", cardId: card.cardId, reason: e.message });
        continue;
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
    }
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

function encodeJiraAuth(email, tokenValue) {
  return Buffer.from(`${email}:${tokenValue}`).toString("base64");
}

async function jiraRequest(management, endpoint, method = "GET", body = null) {
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
    throw new Error(`Jira request failed (${response.status} ${response.statusText}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function jiraSearchIssueByCardId(management, projectKey, cardId) {
  const jql = `project = "${projectKey}" AND description ~ "\\"CARD_ID:\\"" ORDER BY updated DESC`;
  const data = await jiraRequest(
    management,
    `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,labels,description`,
    "GET"
  );
  for (const issue of data.issues || []) {
    const foundId = parseCardIdFromIssueBody(issue.fields?.description || "");
    if (foundId === cardId) return issue;
  }
  return null;
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

function pickJiraTransition(transitions, targetStatus, repoConfig = {}) {
  if (!targetStatus || !Array.isArray(transitions)) return null;

  const candidates = buildOptionCandidates("status", targetStatus, repoConfig);

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

async function jiraApplyStatusTransition(management, issueKey, targetStatus, repoConfig) {
  if (!targetStatus) return { applied: false, reason: "no_status" };

  const transitions = await jiraGetTransitions(management, issueKey);
  const match = pickJiraTransition(transitions, targetStatus, repoConfig);

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

async function jiraLinkIssues(management, inwardKey, outwardKey) {
  const body = {
    type: { name: "Relates" },
    inwardIssue: { key: inwardKey },
    outwardIssue: { key: outwardKey },
  };
  await jiraRequest(management, "/rest/api/2/issueLink", "POST", body);
}

async function runForwardSyncJira(repoConfig, management) {
  if (!management.jiraUrl || !management.jiraProjectKey || !management.jiraEmail || !management.jiraApiToken) {
    throw new Error(
      "Jira backend requires JIRA_URL, JIRA_PROJECT_KEY, JIRA_EMAIL, and JIRA_API_TOKEN (env or config)."
    );
  }

  const allMd = await listMarkdownFiles(cardsRoot);
  if (!allMd.length) {
    log(`No card files found in ${cardsPrefix}/`);
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

  for (const card of syncableCards) {
    const existing = await jiraSearchIssueByCardId(management, management.jiraProjectKey, card.cardId);
    let issueKey;
    if (existing) {
      await jiraUpdateIssue(management, existing.key, card);
      issueKey = existing.key;
      issueByCardId.set(card.cardId, issueKey);
      actions.push({ action: "UPDATED", cardId: card.cardId, issueKey });
    } else {
      const created = await jiraCreateIssue(management, management.jiraProjectKey, card);
      issueKey = created.key;
      issueByCardId.set(card.cardId, issueKey);
      actions.push({ action: "CREATED", cardId: card.cardId, issueKey });
    }

    if (card.status) {
      const transitionResult = await jiraApplyStatusTransition(
        management,
        issueKey,
        card.status,
        repoConfig
      );
      actions.push({
        action: transitionResult.applied ? "STATUS_TRANSITIONED" : "STATUS_SKIPPED",
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
      await jiraLinkIssues(management, parentKey, childKey);
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

// ---------------------------------------------------------------------------
// Forward adapters (Azure DevOps / Linear / GitLab)
// ---------------------------------------------------------------------------

function buildRemoteDescriptionFromCard(card) {
  // Reuse the same metadata block for idempotent search across backends (Jira/Azure/GitLab reverse).
  return buildJiraDescription(card);
}

function basicAuthHeaderFromPat(pat) {
  return Buffer.from(`:${pat}`).toString("base64");
}

function linearCardSearchMarker(card) {
  return `CARD_ID: ${card.cardId}`;
}

function gitlabCardSearchTerm(card) {
  return `CARD_ID: ${card.cardId}`;
}

function buildAzureWiqlForCardId(cardId) {
  // WIQL supports searching by substring in fields like System.Description.
  return `SELECT [System.Id] FROM WorkItems WHERE [System.Description] CONTAINS 'CARD_ID: ${cardId}' ORDER BY [System.Changed Date] DESC`;
}

function buildAzureWiqlForAllCardIds() {
  return `SELECT [System.Id] FROM WorkItems WHERE [System.Description] CONTAINS 'CARD_ID:' ORDER BY [System.Changed Date] DESC`;
}

/** Map Hyperion card.status → remote state label via status_map (or identity). */
function resolveMappedStatus(statusMap, hyperionStatus) {
  if (!hyperionStatus) return null;
  const map = statusMap && typeof statusMap === "object" ? statusMap : {};
  return map[hyperionStatus] || hyperionStatus;
}

/**
 * GitLab issues only have open/closed. Map Done-like statuses to close;
 * otherwise reopen + optional status label.
 */
function resolveGitLabStatusAction(statusMap, hyperionStatus) {
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

/** Build card markdown from SYNC_METADATA description (shared by Jira/Azure/GitLab reverse). */
function remoteIssueToCardMarkdown({ title, description, labels, statusOverride }) {
  const parsed = parseSyncMetadataFromDescription(description);
  if (!parsed) return null;

  const meta = parsed.meta || {};
  const { type, title: parsedTitle } = parseIssueSummaryTypeTitle(title);
  const cardId = meta.CARD_ID || null;
  const sourceFile = meta.SOURCE_FILE || null;
  if (!cardId || !sourceFile) return null;
  // Same policy as local cards: never reverse-sync kit samples / templates
  if (isKitSampleRemoteArtifact({ cardId, sourceFile })) return null;

  const categoriesFromMeta = meta.CATEGORIES
    ? meta.CATEGORIES.split(",").map((x) => x.trim()).filter(Boolean)
    : null;
  const categories = Array.isArray(labels) && labels.length ? labels : categoriesFromMeta || [];
  const typeValue = meta.TYPE || type;
  const statusValue =
    statusOverride !== undefined && statusOverride !== null && String(statusOverride).trim() !== ""
      ? statusOverride
      : meta.STATUS;

  const yaml = [];
  yaml.push("---");
  yaml.push(`card_id: ${yamlQuote(cardId)}`);
  yaml.push(`title: ${yamlQuote(parsedTitle)}`);
  yaml.push(`status: ${yamlNullIfEmpty(statusValue)}`);
  yaml.push(`type: ${yamlQuote(typeValue)}`);
  yaml.push(`priority: ${yamlNullIfEmpty(meta.PRIORITY)}`);
  yaml.push(`sprint: ${yamlNullIfEmpty(meta.SPRINT)}`);
  yaml.push(`story_points: ${yamlNullIfEmptyNumber(meta.STORY_POINTS)}`);
  yaml.push(`reporter: ${yamlNullIfEmpty(meta.REPORTER)}`);
  yaml.push(`parent: ${yamlNullIfEmpty(meta.PARENT_CARD_ID)}`);
  yaml.push(`due_date: ${yamlNullIfEmpty(meta.DUE_DATE)}`);

  if (categories.length) {
    yaml.push("categories:");
    for (const c of categories) yaml.push(`  - ${yamlQuote(c)}`);
  } else {
    yaml.push("categories: []");
  }

  yaml.push("---");
  yaml.push("");
  yaml.push(parsed.bodyContent.trimEnd());
  yaml.push("");

  return { sourceFile, markdown: yaml.join("\n") };
}

async function runForwardSyncAzure(repoConfig, management) {
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

async function runForwardSyncGitLab(repoConfig, management) {
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

  const actions = [];
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

  log("");
  log("=== GITLAB SYNC COMPLETE ===");
  for (const a of actions) log(JSON.stringify(a));
}

async function runForwardSyncLinear(repoConfig, management) {
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

  const actions = [];
  for (const card of syncableCards) {
    const existingId = await linearFindIssueIdByCardId(card.cardId);
    if (dryRun) {
      actions.push({ action: existingId ? "UPDATE" : "CREATE", cardId: card.cardId, linearIssueId: existingId || null });
      continue;
    }
    if (existingId) {
      await linearUpdateIssue(existingId, card);
      actions.push({ action: "UPDATED", cardId: card.cardId, linearIssueId: existingId });
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

  log("");
  log("=== LINEAR SYNC COMPLETE ===");
  for (const a of actions) log(JSON.stringify(a));
}

// ---------------------------------------------------------------------------
// Reverse sync (Backend -> Markdown)
// ---------------------------------------------------------------------------

function parseSyncMetadataFromDescription(description) {
  const text = String(description || "");
  const metaMatch = text.match(/<!-- SYNC_METADATA[\s\S]*?-->\s*([\s\S]*?)\s*<!-- \/SYNC_METADATA -->/);
  if (!metaMatch) return null;

  const metaBlock = metaMatch[1];
  const meta = {};
  for (const line of metaBlock.split("\n")) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    const kv = trimmed.match(/^([A-Z_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    meta[kv[1]] = kv[2].trim();
  }

  const bodyContent = text
    .replace(/\n---\n<!-- SYNC_METADATA[\s\S]*?<!-- \/SYNC_METADATA -->/m, "")
    .trimEnd();

  return { meta, bodyContent };
}

function parseIssueSummaryTypeTitle(summary) {
  const s = String(summary || "").trim();
  const m = s.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (!m) return { type: "Story", title: s || "Untitled" };
  return { type: m[1].trim(), title: m[2].trim() || "Untitled" };
}

function yamlQuote(value) {
  const s = String(value ?? "");
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function yamlNullIfEmpty(value) {
  const s = String(value ?? "").trim();
  return s === "" ? "null" : yamlQuote(s);
}

function yamlNullIfEmptyNumber(value) {
  const s = String(value ?? "").trim();
  if (s === "") return "null";
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : "null";
}

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

function buildCardMarkdownFromMeta(meta, body) {
  const yaml = [];
  yaml.push("---");
  yaml.push(`card_id: ${yamlQuote(meta.card_id)}`);
  yaml.push(`title: ${yamlQuote(meta.title)}`);
  yaml.push(`status: ${yamlNullIfEmpty(meta.status)}`);
  yaml.push(`type: ${yamlQuote(meta.type || "Story")}`);
  yaml.push(`priority: ${yamlNullIfEmpty(meta.priority)}`);
  yaml.push(`sprint: ${yamlNullIfEmpty(meta.sprint)}`);
  yaml.push(`story_points: ${yamlNullIfEmptyNumber(meta.story_points)}`);
  yaml.push(`reporter: ${yamlNullIfEmpty(meta.reporter)}`);
  yaml.push(`parent: ${yamlNullIfEmpty(meta.parent)}`);
  yaml.push(`due_date: ${yamlNullIfEmpty(meta.due_date)}`);
  yaml.push(`board_sync_at: ${yamlNullIfEmpty(meta.board_sync_at)}`);

  const categories = Array.isArray(meta.categories) ? meta.categories : [];
  if (categories.length) {
    yaml.push("categories:");
    for (const c of categories) yaml.push(`  - ${yamlQuote(c)}`);
  } else {
    yaml.push("categories: []");
  }

  yaml.push("---");
  yaml.push("");
  yaml.push(String(body || "").trimEnd());
  yaml.push("");
  return yaml.join("\n");
}

function patchCardFrontmatter(existingContent, updates) {
  const parsed = parseFrontmatter(existingContent);
  if (!parsed) return null;

  const { meta, body } = parsed;
  const next = {
    card_id: meta.card_id,
    title: meta.title ?? extractTitleFromBody(body),
    status: updates.status !== undefined ? updates.status : meta.status,
    type: updates.type !== undefined ? updates.type : meta.type || "Story",
    priority: updates.priority !== undefined ? updates.priority : meta.priority,
    sprint: updates.sprint !== undefined ? updates.sprint : meta.sprint,
    story_points: updates.story_points !== undefined ? updates.story_points : meta.story_points,
    reporter: updates.reporter !== undefined ? updates.reporter : meta.reporter,
    parent: updates.parent !== undefined ? updates.parent : meta.parent,
    due_date: updates.due_date !== undefined ? updates.due_date : meta.due_date,
    categories: updates.categories !== undefined ? updates.categories : meta.categories || [],
    board_sync_at: updates.board_sync_at !== undefined ? updates.board_sync_at : meta.board_sync_at,
  };

  return buildCardMarkdownFromMeta(next, body);
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

function frontmatterDiffers(existingContent, updates) {
  const parsed = parseFrontmatter(existingContent);
  if (!parsed) return true;
  const { meta } = parsed;

  const compare = (key, yamlKey = key) => {
    if (updates[key] === undefined) return false;
    const left = meta[yamlKey] ?? null;
    const right = updates[key] ?? null;
    if (Array.isArray(left) || Array.isArray(right)) {
      return JSON.stringify(left || []) !== JSON.stringify(right || []);
    }
    return String(left ?? "") !== String(right ?? "");
  };

  return (
    compare("status") ||
    compare("type") ||
    compare("priority") ||
    compare("sprint") ||
    compare("story_points") ||
    compare("reporter") ||
    compare("parent") ||
    compare("due_date") ||
    compare("categories") ||
    compare("board_sync_at")
  );
}

/** ISO timestamp from remote issue/work item for optimistic sync locking. */
function remoteBoardSyncAt(issueOrItem) {
  const fields = issueOrItem?.fields || {};
  const raw =
    issueOrItem?.updatedAt ||
    issueOrItem?.updated_at ||
    fields.updated ||
    fields["System.ChangedDate"] ||
    null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? String(raw).trim() || null : d.toISOString();
}

function inverseStatusMap(statusMap) {
  const inv = {};
  for (const [hyperionStatus, remoteStatus] of Object.entries(statusMap || {})) {
    if (remoteStatus) inv[String(remoteStatus)] = hyperionStatus;
  }
  return inv;
}

function resolveHyperionStatusFromRemote(remoteStatus, statusMap, repoConfig) {
  if (!remoteStatus) return null;
  const inv = inverseStatusMap(statusMap);
  if (inv[remoteStatus]) return inv[remoteStatus];

  const norm = normalizeText(remoteStatus);
  for (const [remote, hyperion] of Object.entries(inv)) {
    if (normalizeText(remote) === norm) return hyperion;
  }

  return canonicalizeRemoteOption("status", remoteStatus, repoConfig) || remoteStatus;
}

function canonicalizeLinearState(stateName, statusMap, repoConfig) {
  return resolveHyperionStatusFromRemote(stateName, statusMap, repoConfig);
}

function frontmatterUpdatesFromConvertedMarkdown(converted) {
  if (!converted?.markdown) return {};
  const parsed = parseFrontmatter(converted.markdown);
  if (!parsed?.meta) return {};

  const m = parsed.meta;
  return {
    status: m.status ?? undefined,
    type: m.type ?? undefined,
    priority: m.priority ?? undefined,
    sprint: m.sprint ?? undefined,
    story_points: m.story_points ?? undefined,
    reporter: m.reporter ?? undefined,
    parent: m.parent ?? undefined,
    due_date: m.due_date ?? undefined,
    categories: m.categories ?? undefined,
    board_sync_at: m.board_sync_at ?? undefined,
  };
}

async function applyReverseCardFileUpdate({
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

function countReverseWrite(result) {
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

function jiraIssueToCardMarkdown(issue) {
  return remoteIssueToCardMarkdown({
    title: issue?.fields?.summary,
    description: issue?.fields?.description || "",
    labels: issue?.fields?.labels,
  });
}

async function runReverseSyncJira(repoConfig, management) {
  if (!management.jiraUrl || !management.jiraProjectKey || !management.jiraEmail || !management.jiraApiToken) {
    throw new Error(
      "Jira backend requires JIRA_URL, JIRA_PROJECT_KEY, JIRA_EMAIL, and JIRA_API_TOKEN (env or config)."
    );
  }

  const statusMap = management.statusMap || {};

  log(`Backend: jira`);
  log(`Dry-run: ${dryRun ? "yes" : "no"}`);
  log("Direction: reverse (Jira -> Markdown)");

  const jql = `project = "${management.jiraProjectKey}" AND description ~ "\\"CARD_ID:\\"" ORDER BY updated DESC`;
  const maxResults = 50;
  let startAt = 0;
  const issues = [];

  while (true) {
    const data = await jiraRequest(
      management,
      `/rest/api/2/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=summary,description,labels,status`,
      "GET"
    );

    const batch = data.issues || [];
    issues.push(...batch);

    startAt = Number(data.startAt ?? 0) + batch.length;
    const total = Number(data.total ?? issues.length);
    if (!batch.length || startAt >= total) break;
  }

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

async function runReverseSyncAzure(repoConfig, management) {
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

async function runReverseSyncGitLab(repoConfig, management) {
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

async function runReverseSyncLinear(repoConfig, management) {
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

async function main() {
  if (syncDirection === "reverse") {
    await runReverseSync();
  } else {
    await runForwardSync();
  }
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentFilePath = fileURLToPath(import.meta.url);
const isDirectRun = directRunPath === currentFilePath;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[cards-sync] FATAL ERROR");
    console.error(error);
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
};
