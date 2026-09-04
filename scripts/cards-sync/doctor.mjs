import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import { resolveHyperionPaths } from "../hyperion/paths.mjs";
import {
  discoverGitHubProjectNumber,
  LABELS_OVERLAY_FILENAME,
  STATUS_COLUMNS_OVERLAY_FILENAME,
  resolveOverlayFilePath,
} from "./lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const hyperionPaths = resolveHyperionPaths(process.cwd());
const workspaceRoot = hyperionPaths.workspaceRoot;
const cardsRoot = hyperionPaths.cardsRoot;
const configPath = path.join(cardsRoot, "config", "projects-map.json");
const projectYmlPath = hyperionPaths.projectYmlPath;

const argYes = process.argv.includes("--yes");

function isInteractive() {
  if (argYes) return false;
  // --interactive is accepted for backward compatibility but must never
  // force prompting without a real TTY — that combination hangs forever
  // waiting on stdin in CI/agent shells (npm run cards:doctor hardcodes
  // this flag). Only a genuine TTY can make this true.
  return Boolean(process.stdin.isTTY);
}

async function askYesNo(question) {
  if (!isInteractive()) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} (y/N): `, resolve));
  rl.close();
  const normalized = String(answer || "").trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function log(prefix, msg) {
  console.log(`[doctor] ${prefix} ${msg}`);
}

function warn(msg) {
  log("⚠️", msg);
}

function error(msg) {
  log("❌", msg);
}

function ok(msg) {
  log("✅", msg);
}

async function readJsonIfExists(p) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectRepoFromGit() {
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  } catch {}
  return null;
}

function detectTokenFromGhCli() {
  try {
    return execSync("gh auth token", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {}
  return "";
}

function resolveRepoConfig(config, repositorySlug) {
  const fallback = config.default || {};
  const repoSpecific = config.repositories?.[repositorySlug] || {};
  return {
    ...fallback,
    ...repoSpecific,
    fieldMap: { ...(fallback.fieldMap || {}), ...(repoSpecific.fieldMap || {}) },
    defaults: { ...(fallback.defaults || {}), ...(repoSpecific.defaults || {}) },
  };
}

async function detectBackend(repoConfig) {
  const cfgBackend = repoConfig.backend;
  if (cfgBackend) return String(cfgBackend).toLowerCase();

  try {
    const raw = await fs.readFile(projectYmlPath, "utf8");
    const backendMatch = raw.match(/management:\s*[\s\S]*?backend\s*:\s*([^\s#]+)\s*(?:\n|$)/m);
    if (backendMatch?.[1]) return String(backendMatch[1]).toLowerCase();
  } catch {}

  return "github";
}

// Community MCP packages worth flagging if visibly abandoned — kept in
// sync by hand with the table in .github/mcp/README.md. @azure-devops/mcp
// is excluded: it's the one official (Microsoft) package there, so
// staleness isn't the same kind of signal for it.
const MCP_STALENESS_THRESHOLD_DAYS = 540;
const MCP_COMMUNITY_PACKAGES = new Set(["mcp-atlassian", "mcp-linear", "mcp-gitlab"]);

function extractNpxPackageName(server) {
  if (!server || server.command !== "npx" || !Array.isArray(server.args)) return null;
  return server.args.find((a) => typeof a === "string" && !a.startsWith("-")) || null;
}

/**
 * Best-effort, non-blocking: if the adopter has an MCP server config
 * (.cursor/mcp.json, copied from servers.example.json) referencing one of
 * the community-maintained packages, warn when npm hasn't seen a publish
 * in a long time — the same staleness signal .github/mcp/README.md now
 * documents, just surfaced where an adopter is more likely to see it.
 * Silent on any failure (missing file, no network, npm not on PATH) —
 * this must never make `doctor` itself fail or hang.
 */
async function checkMcpPackageStaleness() {
  const mcpConfigPath = path.join(workspaceRoot, ".cursor", "mcp.json");
  let config;
  try {
    config = JSON.parse(await fs.readFile(mcpConfigPath, "utf8"));
  } catch {
    return;
  }

  const servers = config.mcpServers || {};
  const packages = new Set();
  for (const server of Object.values(servers)) {
    const pkg = extractNpxPackageName(server);
    if (pkg && MCP_COMMUNITY_PACKAGES.has(pkg)) packages.add(pkg);
  }
  if (!packages.size) return;

  for (const pkg of packages) {
    try {
      const modified = execSync(`npm view ${pkg} time.modified`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      const ageDays = (Date.now() - new Date(modified).getTime()) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays > MCP_STALENESS_THRESHOLD_DAYS) {
        warn(
          `MCP package "${pkg}" (configured in .cursor/mcp.json) hasn't published in ~${Math.round(ageDays / 30)} months — community-maintained, review before relying on it. See .github/mcp/README.md.`
        );
      }
    } catch {
      // No network, npm unavailable, or registry lookup failed — skip
      // silently rather than turning a connectivity hiccup into a doctor
      // failure over an informational check.
    }
  }
}

function getMappedFieldNames(repoConfig) {
  const fieldMap = repoConfig.fieldMap || {};
  return {
    status: fieldMap.status || "Status",
    type: fieldMap.type || "Type",
    priority: fieldMap.priority || "Priority",
    sprint: fieldMap.sprint || "Sprint",
    storyPoints: fieldMap.storyPoints || "Story Points",
    reporter: fieldMap.reporter || "Reporter",
    parent: fieldMap.parent || "Parent (Epic/Feature)",
    dueDate: fieldMap.dueDate || "Due Date",
  };
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

function printMissingOptionMapping(repoConfig, locale) {
  const optionMapByLocale = repoConfig.optionMapByLocale || {};
  const has =
    optionMapByLocale[locale] &&
    optionMapByLocale[locale].status &&
    optionMapByLocale[locale].type &&
    optionMapByLocale[locale].priority;
  if (!has) {
    warn(
      `optionMapByLocale incomplete for locale "${locale}" (status/type/priority). Built-in PT/EN alias matching still helps, but safest is to configure optionMapByLocale.`
    );
  } else {
    ok(`optionMapByLocale found for locale "${locale}".`);
  }
}

const EXPECTED_STATUS_OPTIONS = [
  "Backlog",
  "Functional Refinement",
  "Technical Refinement",
  "In Progress",
  "In Tests",
  "In Revision",
  "Done",
];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function checkStatusOptions(statusField) {
  if (!statusField || statusField.__typename !== "ProjectV2SingleSelectField") {
    warn("Status field was not found as a single-select field.");
    return false;
  }

  const optionNames = (statusField.options || []).map((o) => o.name);
  const normalizedExisting = new Set(optionNames.map(normalizeText));
  const missing = EXPECTED_STATUS_OPTIONS.filter(
    (name) => !normalizedExisting.has(normalizeText(name))
  );

  if (!missing.length) {
    ok("Status field options match Hyperion flow (7 columns).");
    return true;
  }

  warn(`Status field is missing Hyperion options: ${missing.join(", ")}.`);
  warn(
    `Current Status options: ${optionNames.join(", ") || "(none)"}`
  );
  warn("Fix in GitHub Project Settings -> Fields -> Status.");
  return false;
}

function checkSprintField(sprintField, configuredName) {
  if (!sprintField) {
    warn(`Sprint iteration field not found (expected: ${configuredName}).`);
    warn("Run npm run cards:sync to auto-create it, or add manually in Project Settings.");
    return false;
  }

  if (sprintField.__typename !== "ProjectV2IterationField") {
    warn(`Sprint field "${sprintField.name}" should be Iteration type, found ${sprintField.__typename}.`);
    return false;
  }

  const iterationCount = sprintField.configuration?.iterations?.length || 0;
  if (iterationCount === 0) {
    ok(`Sprint iteration field OK: ${sprintField.name} (0 iterations — add sprints in Project Settings when ready).`);
  } else {
    ok(`Sprint iteration field OK: ${sprintField.name} (${iterationCount} iteration(s)).`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// GitHub GraphQL (Project existence + fields/options)
// ---------------------------------------------------------------------------

async function graphql({ token }, query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "cards-sync-doctor",
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

async function getProject({ token }, owner, repoName, projectNumber) {
  const projectFieldsFragment = `fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField { id name options { id name } }
      ... on ProjectV2IterationField { id name configuration { iterations { id title } } }
    }
  }`;

  // repository-level project first
  try {
    const data = await graphql(
      { token },
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          projectV2(number: $number) { id ${projectFieldsFragment} }
        }
      }`,
      { owner, name: repoName, number: projectNumber }
    );
    if (data.repository?.projectV2) return data.repository.projectV2;
  } catch {}

  // user-level
  try {
    const data = await graphql(
      { token },
      `query($owner: String!, $number: Int!) {
        user(login: $owner) { projectV2(number: $number) { id ${projectFieldsFragment} } }
      }`,
      { owner, number: projectNumber }
    );
    if (data.user?.projectV2) return data.user.projectV2;
  } catch {}

  // organization-level
  try {
    const data = await graphql(
      { token },
      `query($owner: String!, $number: Int!) {
        organization(login: $owner) { projectV2(number: $number) { id ${projectFieldsFragment} } }
      }`,
      { owner, number: projectNumber }
    );
    if (data.organization?.projectV2) return data.organization.projectV2;
  } catch {}

  return null;
}

function normalizeOptionNames(fieldsNodes) {
  const byName = new Map();
  for (const f of fieldsNodes || []) {
    const name = f?.name;
    if (name) byName.set(String(name).toLowerCase(), f);
  }
  return byName;
}

function findFieldByCandidates(byName, candidates) {
  for (const c of candidates) {
    const f = byName.get(String(c).toLowerCase());
    if (f) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const repositorySlug = process.env.GITHUB_REPOSITORY || detectRepoFromGit() || "unknown/unknown";
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

const config = await readJsonIfExists(configPath);
if (!config) {
  error(`Could not read ${configPath}.`);
  error("Run setup: `cards-sync-setup` skill, or restore projects-map.json.");
  process.exit(1);
}

const repoConfig = resolveRepoConfig(config, repositorySlug);
const locale = repoConfig.locale || "en";
const backend = await detectBackend(repoConfig);

ok(`Repo: ${repoOwner}/${repoName}`);
if (backend !== "github") {
  // Token/tokenSource above are GitHub-specific (gh CLI, GITHUB_TOKEN) — irrelevant noise
  // for a non-GitHub backend, which has its own required-env-var checks below.
} else if (tokenSource === "none") {
  warn("Token source: none — no PROJECT_SYNC_TOKEN, GITHUB_TOKEN, or `gh auth token` available.");
} else if (tokenSource === "gh-cli") {
  warn("Token source: gh-cli — falling back to your local `gh auth token` session. This makes REAL read calls to the GitHub API using your own identity. Set PROJECT_SYNC_TOKEN or GITHUB_TOKEN to avoid this.");
} else {
  ok(`Token source: ${tokenSource}`);
}
ok(`Backend detected: ${backend}`);

// project.yml checks (auto-refresh trigger)
const projectYmlExists = (await fs.stat(projectYmlPath).then(() => true).catch(() => false));
if (!projectYmlExists) {
  warn(`Missing .github/project.yml.`);
  warn("Suggestion: run `project-discovery` in Configure mode, then re-run doctor.");
} else {
  ok(`Found .github/project.yml`);
}

// config shape checks
if (!repoConfig.fieldMap || Object.keys(repoConfig.fieldMap).length === 0) {
  warn("projects-map.json.fieldMap is missing/empty. Field updates may fail.");
}

printMissingOptionMapping(repoConfig, locale);

// labelsFile checks
const labelsFile = repoConfig.labelsFile;
if (!labelsFile) {
  warn("projects-map.json.default.labelsFile missing. Labels i18n may not work, but categories labels can still be created on-the-fly.");
} else {
  const resolved = labelsFile.includes("{locale}") ? labelsFile.replaceAll("{locale}", locale) : labelsFile;
  const fullPath = path.isAbsolute(resolved) ? resolved : path.join(cardsRoot, "config", resolved);
  const labelsExists = (await fs.stat(fullPath).then(() => true).catch(() => false));
  if (!labelsExists) warn(`labelsFile resolved path not found: ${fullPath}`);
  else ok(`labelsFile OK: ${fullPath}`);
}
const labelsOverlayPath = resolveOverlayFilePath(cardsRoot, LABELS_OVERLAY_FILENAME);
if (await fs.stat(labelsOverlayPath).then(() => true).catch(() => false)) {
  ok(`labels overlay OK: ${labelsOverlayPath} (merged into the base catalog)`);
}

const statusColumnsFile = repoConfig.statusColumnsFile;
if (!statusColumnsFile) {
  warn("projects-map.json.default.statusColumnsFile missing. Status columns will use built-in fallback palette.");
} else {
  const resolved = statusColumnsFile.includes("{locale}")
    ? statusColumnsFile.replaceAll("{locale}", locale)
    : statusColumnsFile;
  const fullPath = path.isAbsolute(resolved) ? resolved : path.join(cardsRoot, "config", resolved);
  const exists = await fs.stat(fullPath).then(() => true).catch(() => false);
  if (!exists) warn(`statusColumnsFile resolved path not found: ${fullPath}`);
  else ok(`statusColumnsFile OK: ${fullPath}`);
}
const statusColumnsOverlayPath = resolveOverlayFilePath(cardsRoot, STATUS_COLUMNS_OVERLAY_FILENAME);
if (await fs.stat(statusColumnsOverlayPath).then(() => true).catch(() => false)) {
  ok(`status columns overlay OK: ${statusColumnsOverlayPath} (merged into the base catalog)`);
}

// remote project checks (only if we have token + projectNumber)
const projectOwner = process.env.PROJECT_OWNER || repoConfig.projectOwner || repoOwner;
const projectNumber = Number(process.env.PROJECT_NUMBER || "0") || Number(repoConfig.projectNumber || "0");

log("info", `Resolved project: owner="${projectOwner}", number=${projectNumber}`);

if (!token && backend === "github") {
  warn("No GitHub token available. Doctor will only do local checks.");
  process.exit(0);
}

if (backend === "jira") {
  const jiraUrl = process.env.JIRA_URL || null;
  const jiraProjectKey = process.env.JIRA_PROJECT_KEY || null;
  const jiraEmail = process.env.JIRA_EMAIL || null;
  const jiraToken = process.env.JIRA_API_TOKEN || null;
  const jiraIssueType = process.env.JIRA_ISSUE_TYPE || "Task";

  if (!jiraUrl || !jiraProjectKey || !jiraEmail || !jiraToken) {
    warn("Jira backend detected. Missing one or more required env vars:");
    warn("JIRA_URL, JIRA_PROJECT_KEY, JIRA_EMAIL, JIRA_API_TOKEN");
    process.exit(1);
  }

  function encodeJiraAuth() {
    return Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64");
  }

  async function jiraRequest(endpoint, method = "GET") {
    const baseUrl = String(jiraUrl).replace(/\/+$/, "");
    const url = `${baseUrl}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${encodeJiraAuth()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      throw new Error(`Jira request failed (${response.status} ${response.statusText})`);
    }
    return payload || {};
  }

  ok("Jira backend env vars detected.");
  log("Checking Jira project exists...");
  await jiraRequest(`/rest/api/2/project/${encodeURIComponent(jiraProjectKey)}`);
  ok(`Jira project OK: ${jiraProjectKey}`);

  log(`Checking Jira issue type is creatable: ${jiraIssueType}...`);
  await jiraRequest(
    `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(jiraProjectKey)}&issuetypeNames=${encodeURIComponent(
      jiraIssueType
    )}&expand=projects.issuetypes.fields`
  );
  ok(`Jira issue type OK: ${jiraIssueType}`);

  ok("Doctor finished (Jira remote checks passed).");
  process.exit(0);
}

if (backend === "azure-devops" || backend === "azure") {
  const azureOrgUrl = process.env.AZDO_ORG_URL || repoConfig.org || null;
  const azureProject = process.env.AZDO_PROJECT || repoConfig.project || null;
  const azurePat = process.env.AZDO_PAT || null;
  if (!azureOrgUrl || !azureProject || !azurePat) {
    warn("Azure DevOps backend detected. Missing one or more required env vars:");
    warn("AZDO_ORG_URL, AZDO_PROJECT, AZDO_PAT");
    process.exit(1);
  }
  const baseUrl = String(azureOrgUrl).replace(/\/+$/, "");
  const auth = Buffer.from(`:${azurePat}`).toString("base64");
  const url = `${baseUrl}/_apis/projects/${encodeURIComponent(azureProject)}?api-version=7.0`;
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!response.ok) {
    error(`Azure project check failed (${response.status}).`);
    process.exit(1);
  }
  ok(`Azure project OK: ${azureProject}`);
  const statusMap = repoConfig.status_map || repoConfig.statusMap || {};
  if (!statusMap || Object.keys(statusMap).length === 0) {
    warn("status_map is empty — Azure System.State updates will use Hyperion status names as-is.");
  } else {
    ok("status_map present for Azure state mapping.");
  }
  ok("Doctor finished (Azure remote checks passed).");
  process.exit(0);
}

if (backend === "gitlab") {
  const gitlabUrl = String(process.env.GITLAB_URL || repoConfig.url || "https://gitlab.com").replace(/\/+$/, "");
  const gitlabProjectId = process.env.GITLAB_PROJECT_ID || repoConfig.project_id || null;
  const gitlabToken = process.env.GITLAB_TOKEN || null;
  if (!gitlabProjectId || !gitlabToken) {
    warn("GitLab backend detected. Missing one or more required env vars:");
    warn("GITLAB_PROJECT_ID, GITLAB_TOKEN (optional GITLAB_URL)");
    process.exit(1);
  }
  const response = await fetch(`${gitlabUrl}/api/v4/projects/${encodeURIComponent(gitlabProjectId)}`, {
    headers: { "PRIVATE-TOKEN": gitlabToken, Accept: "application/json" },
  });
  if (!response.ok) {
    error(`GitLab project check failed (${response.status}).`);
    process.exit(1);
  }
  ok(`GitLab project OK: ${gitlabProjectId}`);
  const statusMap = repoConfig.status_map || repoConfig.statusMap || {};
  if (!statusMap || Object.keys(statusMap).length === 0) {
    warn("status_map is empty — GitLab status will map Done→close and others→reopen + status: label.");
  } else {
    ok("status_map present for GitLab status mapping.");
  }
  ok("Doctor finished (GitLab remote checks passed).");
  process.exit(0);
}

if (backend === "linear") {
  const linearTeamId = process.env.LINEAR_TEAM_ID || repoConfig.team || null;
  const linearApiToken = process.env.LINEAR_API_TOKEN || null;
  if (!linearTeamId || !linearApiToken) {
    warn("Linear backend detected. Missing LINEAR_TEAM_ID and/or LINEAR_API_TOKEN.");
    process.exit(1);
  }
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: linearApiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query($id: String!) { team(id: $id) { id name } }`,
      variables: { id: linearTeamId },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors || !payload?.data?.team) {
    error(`Linear team check failed: ${JSON.stringify(payload.errors || payload)}`);
    process.exit(1);
  }
  ok(`Linear team OK: ${payload.data.team.name || linearTeamId}`);
  ok("Doctor finished (Linear remote checks passed).");
  process.exit(0);
}

if (backend !== "github") {
  warn(`Unknown backend="${backend}". Supported: github, jira, azure-devops, linear, gitlab.`);
  process.exit(1);
}

if (!projectNumber || projectNumber <= 0) {
  if (repoConfig.autoCreateProject === false) {
    warn("projectNumber not set (or <=0) and autoCreateProject is false. You must create the Project manually.");
    process.exit(0);
  }

  // sync.mjs auto-discovers an existing GitHub Project by name/repo match
  // before it ever considers creating one — check the same way here
  // (persist: false, so this stays a read-only preview) instead of
  // unconditionally reporting "missing".
  const discovery = token
    ? await discoverGitHubProjectNumber({
        token,
        owner: repoOwner,
        repoName,
        repoConfig,
        configPath,
        repositorySlug,
        persist: false,
      })
    : { discovered: false, reason: "no_token" };

  if (discovery.discovered) {
    ok(`sync.mjs would auto-discover GitHub Project #${discovery.projectNumber}: "${discovery.projectTitle}"`);
    warn("Not yet saved to projects-map.json — run `npm run cards:sync` (or `npm run cards:dry-run` to preview) to pick it up.");
    process.exit(0);
  }

  const wants = await askYesNo("Project number missing. Can I run sync.mjs to auto-create the GitHub Project?");
  if (wants) {
    log("info", "Running sync.mjs (real mode) to auto-create project/fields/labels...");
    const res = spawnSync("node", ["scripts/cards-sync/sync.mjs"], {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: process.env,
    });
    process.exit(res.status ?? 1);
  }
  if (discovery.reason === "ambiguous") {
    warn("Multiple GitHub Projects found — set projectNumber in projects-map.json to disambiguate.");
    for (const c of discovery.candidates || []) warn(`  candidate: #${c.number} ${c.title}`);
  } else {
    warn("Auto-create skipped. Run `npm run cards:sync` when you're ready — it will create a new Project.");
  }
  process.exit(0);
}

const project = await getProject({ token }, projectOwner, repoName, projectNumber);
if (!project) {
  warn(`GitHub Project not found for owner="${projectOwner}" number=${projectNumber}.`);

  if (repoConfig.autoCreateProject === false) {
    warn("autoCreateProject is false in projects-map.json. Create it manually or set autoCreateProject=true.");
    process.exit(0);
  }

  const wants = await askYesNo("Project not found. Can I set projects-map.json.projectNumber to 0 and re-run sync to auto-create?");
  if (!wants) {
    warn("Auto-create skipped. You can set projectNumber to 0 manually, then run sync.mjs.");
    process.exit(0);
  }

  // Edit config: set default.projectNumber = 0
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const obj = JSON.parse(raw);
    if (!obj.default) obj.default = {};
    obj.default.projectNumber = 0;
    await fs.writeFile(configPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
    ok("projects-map.json updated: default.projectNumber=0");
  } catch (e) {
    error(`Could not edit projects-map.json: ${e.message}`);
    process.exit(1);
  }

  const res = spawnSync("node", ["scripts/cards-sync/sync.mjs"], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

ok(`Project found. Checking required fields...`);

const required = getMappedFieldNames(repoConfig);
const fieldsNodes = project?.fields?.nodes || [];
const byName = normalizeOptionNames(fieldsNodes);

const missingFields = [];
for (const [key, configuredName] of Object.entries(required)) {
  const candidates = [configuredName, ...(FIELD_NAME_ALIASES[key] || [])];
  const found = findFieldByCandidates(byName, candidates);
  if (!found) missingFields.push(configuredName);
}
if (missingFields.length) {
  warn(`Missing required Project fields: ${missingFields.join(", ")}`);
  warn("Fix options:");
  warn("1) Run `npm run cards:project-fields-apply -- --yes` to create/rename them on this Project");
  warn("2) Or create those fields manually in Project Settings");
  warn("3) Or set projects-map.json.default.projectNumber=0 and let sync auto-create a fresh Project (if acceptable)");
} else {
  ok("All required Project fields exist.");
}

const statusCandidates = [required.status, ...(FIELD_NAME_ALIASES.status || [])];
const statusField = findFieldByCandidates(byName, statusCandidates);
const statusOk = checkStatusOptions(statusField);

const sprintCandidates = [required.sprint, ...(FIELD_NAME_ALIASES.sprint || [])];
const sprintField = findFieldByCandidates(byName, sprintCandidates);
const sprintOk = checkSprintField(sprintField, required.sprint);

await checkMcpPackageStaleness();

ok("Doctor finished.");
process.exit(missingFields.length || !statusOk || !sprintOk ? 1 : 0);

