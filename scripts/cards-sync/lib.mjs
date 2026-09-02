import fs from "node:fs/promises";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

export function detectRepoFromGit() {
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

export function detectTokenFromGhCli() {
  try {
    return execSync("gh auth token", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {}
  return "";
}

export async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function resolveRepoConfig(config, repositorySlug) {
  const fallback = config.default || {};
  const repoSpecific = config.repositories?.[repositorySlug] || {};
  return {
    ...fallback,
    ...repoSpecific,
    fieldMap: { ...(fallback.fieldMap || {}), ...(repoSpecific.fieldMap || {}) },
    defaults: { ...(fallback.defaults || {}), ...(repoSpecific.defaults || {}) },
    optionMapByLocale: {
      ...(fallback.optionMapByLocale || {}),
      ...(repoSpecific.optionMapByLocale || {}),
    },
  };
}

export function cardIdFromRelativePath(relativePath) {
  const base = path.basename(relativePath, path.extname(relativePath));
  return base && base.toLowerCase() !== "readme" ? base : null;
}

export function parseOnlyFilter(argv = process.argv) {
  const onlyIdx = argv.indexOf("--only");
  if (onlyIdx >= 0 && argv[onlyIdx + 1]) {
    return argv[onlyIdx + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const envOnly = process.env.CARDS_SYNC_ONLY;
  if (envOnly) {
    return envOnly.split(",").map((s) => s.trim()).filter(Boolean);
  }

  return null;
}

/** Kit reference material — never forward-sync unless --include-samples (maintainers only). */
export function isKitSampleCardId(cardId) {
  return /^(EXAMPLE|TEMPLATE|SAMPLE)-/i.test(String(cardId || ""));
}

/** @deprecated use isKitSampleCardId */
export function isExampleCardId(cardId) {
  return isKitSampleCardId(cardId);
}

export function isNonSyncCardPath(relativePath) {
  const norm = String(relativePath || "").replace(/\\/g, "/").toLowerCase();
  if (norm.endsWith(".template.md")) return true;
  if (/(^|\/)_examples(\/|$)/.test(norm)) return true;
  // Never treat GitHub issue/PR templates as syncable card sources
  if (/(^|\/)\.github\/issue_template(\/|$)/.test(norm)) return true;
  if (/(^|\/)\.github\/pull_request_template\.md$/.test(norm)) return true;
  if (/(^|\/)pull_request_template\.md$/.test(norm)) return true;
  return false;
}

/**
 * Remote issues/PRs that belong to kit samples must not reverse-sync (or map)
 * unless --include-samples (maintainers only). Same policy as local cards.
 */
export function isKitSampleRemoteArtifact({ cardId, sourceFile } = {}, options = {}) {
  const includeSamples = options.includeSamples ?? shouldIncludeKitSamples(options.argv);
  if (includeSamples) return false;
  if (isKitSampleCardId(cardId)) return true;
  if (sourceFile && isNonSyncCardPath(sourceFile)) return true;
  return false;
}

export function shouldIncludeKitSamples(argv = process.argv) {
  if (argv.includes("--include-samples") || argv.includes("--include-examples")) return true;
  const env =
    process.env.CARDS_SYNC_INCLUDE_SAMPLES || process.env.CARDS_SYNC_INCLUDE_EXAMPLES || "";
  return String(env).toLowerCase() === "true";
}

/** @deprecated use shouldIncludeKitSamples */
export function shouldIncludeExampleCards(argv) {
  return shouldIncludeKitSamples(argv);
}

export function filterKitSampleCards(cards, onlyIds, options = {}) {
  const includeSamples = options.includeSamples ?? shouldIncludeKitSamples(options.argv);
  if (includeSamples) return { cards, skipped: 0, ignoredOnlyTargets: [] };

  const filtered = cards.filter((c) => !isKitSampleCardId(c.cardId));
  const skipped = cards.length - filtered.length;
  const ignoredOnlyTargets = (onlyIds || []).filter((id) => isKitSampleCardId(id));
  return { cards: filtered, skipped, ignoredOnlyTargets };
}

/** @deprecated use filterKitSampleCards */
export function filterExampleSampleCards(cards, onlyIds, options = {}) {
  return filterKitSampleCards(cards, onlyIds, options);
}

const CARD_LIST_SKIP_DIRS = new Set(["config", "synced"]);
const CARD_LIST_SYNC_SKIP_DIRS = new Set(["_examples"]);

/** Map frontmatter `type` → folder under cards root. */
export const CARD_TYPE_DIR = {
  Epic: "epics",
  Feature: "features",
  Story: "stories",
  Task: "tasks",
  Subtask: "tasks",
  Bug: "tasks",
};

/**
 * Canonical relative path for a card (posix).
 * Nested by direct `parent` card_id: features/{parent}/{id}.md, etc.
 * Epics stay flat. Missing parent (non-epic) → `{typeDir}/_orphan/{id}.md`.
 *
 * @param {{ type?: string, cardId: string, parent?: string|null, cardsPrefix?: string }} opts
 *   cardsPrefix — default `.github/cards`; use `Hyperion/.github/cards` when nested.
 */
export function resolveCardRelativePath({ type, cardId, parent, cardsPrefix = ".github/cards" } = {}) {
  const id = String(cardId || "").trim();
  if (!id) throw new Error("resolveCardRelativePath: cardId is required");

  const prefix = String(cardsPrefix || ".github/cards")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const typeDir = CARD_TYPE_DIR[type] || CARD_TYPE_DIR.Story;
  const parentId =
    parent === null || parent === undefined || parent === ""
      ? null
      : String(parent).trim();

  if (typeDir === "epics") {
    return `${prefix}/epics/${id}.md`;
  }

  if (parentId) {
    return `${prefix}/${typeDir}/${parentId}/${id}.md`;
  }

  return `${prefix}/${typeDir}/_orphan/${id}.md`;
}

/**
 * Compare actual relative path to the nested-by-parent convention.
 * @returns {{ ok: boolean, expected: string, legacyFlat: boolean }}
 */
export function checkCardPathLayout(
  relativeFile,
  { type, cardId, parent, cardsPrefix = ".github/cards" } = {}
) {
  const actual = String(relativeFile || "").replace(/\\/g, "/");
  const expected = resolveCardRelativePath({ type, cardId, parent, cardsPrefix });
  if (actual === expected) {
    return { ok: true, expected, legacyFlat: false };
  }

  const prefix = String(cardsPrefix || ".github/cards")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const typeDir = CARD_TYPE_DIR[type] || CARD_TYPE_DIR.Story;
  const id = String(cardId || "").trim();
  const legacyFlat = actual === `${prefix}/${typeDir}/${id}.md`;

  return { ok: false, expected, legacyFlat };
}

export async function listCardsMarkdownFiles(dir, { forSync = false } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (CARD_LIST_SKIP_DIRS.has(entry.name)) continue;
      if (forSync && CARD_LIST_SYNC_SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await listCardsMarkdownFiles(full, { forSync })));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const lower = entry.name.toLowerCase();
      if (lower === "readme.md" || lower.endsWith(".template.md")) continue;
      files.push(full);
    }
  }
  return files;
}

export function expandCardIdsWithParents(cards, onlyIds) {
  if (!onlyIds?.length) return cards;

  const target = new Set(onlyIds);
  const byId = new Map(cards.map((c) => [c.cardId, c]));

  for (const id of [...target]) {
    let current = byId.get(id);
    while (current?.parent) {
      target.add(current.parent);
      current = byId.get(current.parent);
    }
  }

  return cards.filter((c) => target.has(c.cardId));
}

export function filterEdgesForCards(edges, cardIds) {
  const set = new Set(cardIds);
  return edges.filter((e) => set.has(e.parentCardId) && set.has(e.childCardId));
}

export function pickBestGitHubProject(projects, repoName) {
  if (!Array.isArray(projects) || projects.length === 0) return null;

  const kitTitle = `${repoName} Hyperion Project`;
  const exact = projects.find((p) => p.title === kitTitle);
  if (exact) return exact;

  const kitMatch = projects.find((p) => /hyperion/i.test(p.title || ""));
  if (kitMatch) return kitMatch;

  if (projects.length === 1) return projects[0];

  return null;
}

export async function githubGraphql(token, query, variables = {}) {
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

export async function listGitHubProjects(token, owner, repoName) {
  const collected = [];

  try {
    const data = await githubGraphql(
      token,
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          projectsV2(first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { number title id }
          }
        }
      }`,
      { owner, name: repoName }
    );
    collected.push(...(data.repository?.projectsV2?.nodes || []));
  } catch {}

  if (collected.length) return collected;

  for (const scope of ["user", "organization"]) {
    try {
      const query =
        scope === "user"
          ? `query($owner: String!) { user(login: $owner) { projectsV2(first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title id } } } } }`
          : `query($owner: String!) { organization(login: $owner) { projectsV2(first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title id } } } } }`;
      const data = await githubGraphql(token, query, { owner });
      const nodes =
        scope === "user"
          ? data.user?.projectsV2?.nodes
          : data.organization?.projectsV2?.nodes;
      if (nodes?.length) return nodes;
    } catch {}
  }

  return collected;
}

export async function saveProjectToConfig(configPath, repositorySlug, { projectNumber, projectOwner }) {
  const config = (await readJsonIfExists(configPath)) || { default: {} };

  if (config.repositories?.[repositorySlug]) {
    config.repositories[repositorySlug].projectNumber = projectNumber;
    if (projectOwner) config.repositories[repositorySlug].projectOwner = projectOwner;
  } else {
    config.default = config.default || {};
    config.default.projectNumber = projectNumber;
    if (projectOwner) config.default.projectOwner = projectOwner;
  }

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function discoverGitHubProjectNumber({
  token,
  owner,
  repoName,
  repoConfig,
  configPath,
  repositorySlug,
  persist = true,
}) {
  const existing = Number(repoConfig.projectNumber || 0);
  if (existing > 0) {
    return { discovered: false, reason: "already_configured", projectNumber: existing };
  }

  if (!token) {
    return { discovered: false, reason: "no_token" };
  }

  if (repoConfig.autoDiscoverProject === false) {
    return { discovered: false, reason: "auto_discover_disabled" };
  }

  const projects = await listGitHubProjects(token, owner, repoName);
  const picked = pickBestGitHubProject(projects, repoName);

  if (!picked) {
    return {
      discovered: false,
      reason: projects.length > 1 ? "ambiguous" : "not_found",
      candidates: projects.map((p) => ({ number: p.number, title: p.title })),
    };
  }

  const projectOwner = repoConfig.projectOwner || owner;
  if (persist) {
    await saveProjectToConfig(configPath, repositorySlug, {
      projectNumber: picked.number,
      projectOwner,
    });
  }

  return {
    discovered: true,
    projectNumber: picked.number,
    projectTitle: picked.title,
    projectOwner,
  };
}

/** Parse SYNC_METADATA block from a GitHub issue body (not full description). */
export function parseSyncMetadataFromIssueBody(body) {
  const text = String(body || "");
  const metaMatch = text.match(/<!-- SYNC_METADATA[\s\S]*?-->\s*([\s\S]*?)\s*<!-- \/SYNC_METADATA -->/);
  if (!metaMatch) return null;

  const meta = {};
  for (const line of metaMatch[1].split("\n")) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    const kv = trimmed.match(/^([A-Z_]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return meta;
}

/** CARD_ID from SYNC_METADATA only — avoids matching PARENT_CARD_ID substring. */
export function parseCardIdFromIssueBody(body) {
  const meta = parseSyncMetadataFromIssueBody(body);
  const cardId = meta?.CARD_ID?.trim();
  return cardId || null;
}

export function parseSourceFileFromIssueBody(body) {
  const meta = parseSyncMetadataFromIssueBody(body);
  return meta?.SOURCE_FILE?.trim() || null;
}

/** When multiple issues share a CARD_ID, prefer OPEN then lowest issue number. */
export function pickCanonicalIssueForCardId(existing, candidate) {
  if (!existing) return candidate;
  if (!candidate) return existing;

  const existingOpen = String(existing.state || "").toUpperCase() === "OPEN";
  const candidateOpen = String(candidate.state || "").toUpperCase() === "OPEN";
  if (existingOpen && !candidateOpen) return existing;
  if (!existingOpen && candidateOpen) return candidate;

  const existingNum = Number(existing.number) || Infinity;
  const candidateNum = Number(candidate.number) || Infinity;
  return candidateNum < existingNum ? candidate : existing;
}

/** Resolve SOURCE_FILE paths for legacy flat vs nested kit.root layouts. */
export function resolveSourceFileCandidates(sourceFile, { kitRootRel } = {}) {
  const norm = String(sourceFile || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
  if (!norm) return [];

  const candidates = [norm];
  const kit = String(kitRootRel || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  if (kit && !norm.startsWith(`${kit}/`)) {
    candidates.push(`${kit}/${norm}`);
  }
  if (kit && norm.startsWith(`${kit}/`)) {
    const stripped = norm.slice(kit.length + 1);
    if (stripped) candidates.push(stripped);
  }

  return [...new Set(candidates)];
}

export async function readLocalCardFromSourceFile(sourceFile, { workspaceRoot, kitRootRel } = {}) {
  const candidates = resolveSourceFileCandidates(sourceFile, { kitRootRel });
  for (const rel of candidates) {
    const abs = path.join(workspaceRoot, rel);
    try {
      const content = await fs.readFile(abs, "utf8");
      return { relativeFile: rel.replace(/\\/g, "/"), absolutePath: abs, content };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** CARD_ID from remote description (Jira/Azure/GitLab) — SYNC_METADATA block only. */
export function parseCardIdFromRemoteDescription(description) {
  return parseCardIdFromIssueBody(description);
}

/**
 * After reverse sync in CI: detect if board state differs from committed card markdown.
 * @returns {{ aligned: boolean, files: string[], gitAvailable: boolean, warning?: string }}
 */
export function checkBoardRepoAlignment(workspaceRoot, cardsPrefix) {
  const cardsPath = String(cardsPrefix || ".github/cards").replace(/\\/g, "/").replace(/\/+$/, "");
  const diff = spawnSync("git", ["diff", "--name-only", "--", `${cardsPath}/`], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  if (diff.error) {
    return {
      aligned: true,
      files: [],
      gitAvailable: false,
      warning: diff.error.message,
    };
  }

  const files = (diff.stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.toLowerCase().endsWith(".md"));

  return {
    aligned: files.length === 0,
    files,
    gitAvailable: true,
  };
}

/** Fail CI pull-before-push when projectNumber is missing (board fields won't reverse). */
export async function assertCiProjectConfigured(configPath, repositorySlug, { backend = "github" } = {}) {
  const normalizedBackend = String(backend || "github").toLowerCase();
  if (normalizedBackend !== "github") {
    return { ok: true, skipped: true, reason: "not_github_backend" };
  }

  if (String(process.env.CARDS_CI_REQUIRE_PROJECT || "").toLowerCase() !== "true") {
    return { ok: true, skipped: true };
  }

  const config = (await readJsonIfExists(configPath)) || {};
  const repoConfig = resolveRepoConfig(config, repositorySlug);
  const projectNumber = Number(repoConfig.projectNumber || 0);

  if (projectNumber <= 0) {
    return {
      ok: false,
      reason: "missing_project_number",
      message:
        "CI pull-before-push requires projectNumber in projects-map.json. Run: npm run cards:doctor",
    };
  }

  return { ok: true, projectNumber, projectOwner: repoConfig.projectOwner || null };
}

/** Resolve cards-sync backend from env, project.yml, or projects-map.json. */
export async function readSyncBackendHint({ projectYmlPath, projectsMapPath, repositorySlug } = {}) {
  if (process.env.CARDS_SYNC_BACKEND) {
    return String(process.env.CARDS_SYNC_BACKEND).toLowerCase();
  }

  if (projectYmlPath) {
    try {
      const raw = await fs.readFile(projectYmlPath, "utf8");
      const m = raw.match(/^\s*backend\s*:\s*(\S+)/m);
      if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
      const mgmt = raw.match(/^\s*management\s*:\s*\n[\s\S]*?^\s{2}backend\s*:\s*(\S+)/m);
      if (mgmt?.[1]) return mgmt[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
    } catch {
      /* ignore */
    }
  }

  if (projectsMapPath && repositorySlug) {
    const config = await readJsonIfExists(projectsMapPath);
    const repoConfig = resolveRepoConfig(config || {}, repositorySlug);
    if (repoConfig?.backend) return String(repoConfig.backend).toLowerCase();
    if (repoConfig?.management?.backend) return String(repoConfig.management.backend).toLowerCase();
  }

  return "github";
}

export async function writeSyncSummary({
  workspaceRoot,
  plansCardsDir,
  repositorySlug,
  projectOwner,
  projectNumber,
  actions,
  cardCount,
  incrementalIds,
}) {
  const outDir = plansCardsDir || path.join(workspaceRoot, ".github", "plans", "cards");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "last-sync.md");

  const when = new Date().toISOString();
  const lines = [
    "# Last cards sync",
    "",
    `- **When:** ${when}`,
    `- **Repository:** ${repositorySlug}`,
  ];

  if (projectNumber) {
    lines.push(`- **Project:** ${projectOwner}#${projectNumber}`);
  }

  lines.push(`- **Cards processed:** ${cardCount}`);
  if (incrementalIds?.length) {
    lines.push(`- **Incremental:** ${incrementalIds.join(", ")}`);
  }

  lines.push("", "## Actions", "", "| Card ID | Action | Details |", "|---------|--------|---------|");

  for (const action of actions) {
    const cardId = action.cardId || action.parent || "—";
    const type = action.action || "UNKNOWN";
    const details = action.url || action.number || action.reason || action.transition || "";
    lines.push(`| ${cardId} | ${type} | ${details} |`);
  }

  if (actions.length === 0) {
    lines.push("| — | — | No actions recorded |");
  }

  lines.push("");
  await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Labels catalog (v2: name + color + description; v1: string[])
// ---------------------------------------------------------------------------

/** Deterministic fallback color when catalog omits `color`. */
export function colorFromString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return (hash & 0xffffff).toString(16).padStart(6, "0");
}

export function normalizeLabelColor(color) {
  if (!color) return null;
  const hex = String(color).replace(/^#/, "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return hex.toLowerCase();
}

/** @returns {{ name: string, color: string, description: string } | null} */
export function normalizeLabelEntry(entry) {
  if (typeof entry === "string") {
    const name = entry.trim();
    return name ? { name, color: colorFromString(name), description: "" } : null;
  }
  if (entry && typeof entry === "object" && typeof entry.name === "string") {
    const name = entry.name.trim();
    if (!name) return null;
    const color = normalizeLabelColor(entry.color) || colorFromString(name);
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    return { name, color, description };
  }
  return null;
}

/** Parse labels catalog JSON (array of strings or objects). */
export function parseLabelsCatalogJson(parsed) {
  if (!Array.isArray(parsed)) return [];
  const specs = [];
  const seen = new Set();
  for (const entry of parsed) {
    const spec = normalizeLabelEntry(entry);
    if (!spec || seen.has(spec.name)) continue;
    seen.add(spec.name);
    specs.push(spec);
  }
  return specs;
}

export function labelNamesFromCatalog(specs) {
  return specs.map((s) => s.name);
}

export async function detectProjectLocaleFromYml(projectYmlPath) {
  try {
    const raw = await fs.readFile(projectYmlPath, "utf8");
    const match = raw.match(/^\s*locale\s*:\s*([^\s#]+)\s*$/m);
    if (match?.[1]) return match[1];
  } catch {}
  return null;
}

export function resolveLabelsCatalogFilePath(cardsRoot, repoConfig, locale) {
  if (Array.isArray(repoConfig.labels)) return null;
  const labelsFile = repoConfig.labelsFile;
  if (!labelsFile) return null;
  const resolvedFileName = labelsFile.includes("{locale}")
    ? labelsFile.replaceAll("{locale}", locale)
    : labelsFile;
  return path.isAbsolute(resolvedFileName)
    ? resolvedFileName
    : path.join(cardsRoot, "config", resolvedFileName);
}

/**
 * labels.custom.json — optional, per-repo overlay living next to the base
 * locale catalogs in the same config/ dir. Same array-of-spec shape as
 * labels.en.json. Entries are merged into the base catalog by `name`
 * (overlay wins on a name collision, is appended otherwise), so a product
 * can add domain-specific labels (e.g. "Payment", "Search") without
 * forking the kit's generic default catalog.
 */
export const LABELS_OVERLAY_FILENAME = "labels.custom.json";
export const STATUS_COLUMNS_OVERLAY_FILENAME = "status-columns.custom.json";

export function resolveOverlayFilePath(cardsRoot, filename) {
  return path.join(cardsRoot, "config", filename);
}

export function mergeLabelSpecs(baseSpecs, overlaySpecs) {
  const byName = new Map(baseSpecs.map((s) => [s.name, s]));
  for (const spec of overlaySpecs) byName.set(spec.name, spec);
  return [...byName.values()];
}

export function mergeStatusColumnSpecs(baseSpecs, overlaySpecs) {
  const byKey = new Map(baseSpecs.map((s) => [s.key, s]));
  for (const spec of overlaySpecs) byKey.set(spec.key, spec);
  return [...byKey.values()];
}

async function readOverlaySpecs(cardsRoot, filename, parseFn) {
  const file = resolveOverlayFilePath(cardsRoot, filename);
  try {
    const raw = await fs.readFile(file, "utf8");
    return { specs: parseFn(JSON.parse(raw)), file };
  } catch {
    return { specs: [], file: null };
  }
}

export async function loadLabelsCatalog({ cardsRoot, repoConfig, projectLocale = null }) {
  const locale = repoConfig.locale || projectLocale || "en";
  const overlay = await readOverlaySpecs(cardsRoot, LABELS_OVERLAY_FILENAME, parseLabelsCatalogJson);

  if (Array.isArray(repoConfig.labels)) {
    const specs = mergeLabelSpecs(parseLabelsCatalogJson(repoConfig.labels), overlay.specs);
    return {
      locale,
      specs,
      names: labelNamesFromCatalog(specs),
      file: "(inline config)",
      overlayFile: overlay.file,
    };
  }

  const file = resolveLabelsCatalogFilePath(cardsRoot, repoConfig, locale);
  if (!file) {
    const specs = overlay.specs;
    return { locale, specs, names: labelNamesFromCatalog(specs), file: null, overlayFile: overlay.file };
  }

  try {
    const raw = await fs.readFile(file, "utf8");
    const specs = mergeLabelSpecs(parseLabelsCatalogJson(JSON.parse(raw)), overlay.specs);
    return { locale, specs, names: labelNamesFromCatalog(specs), file, overlayFile: overlay.file };
  } catch {
    return { locale, specs: overlay.specs, names: labelNamesFromCatalog(overlay.specs), file, overlayFile: overlay.file };
  }
}

// ---------------------------------------------------------------------------
// Status columns catalog (Project single-select / board columns)
// ---------------------------------------------------------------------------

export const PROJECT_V2_SELECT_COLORS = new Set([
  "GRAY",
  "BLUE",
  "GREEN",
  "YELLOW",
  "ORANGE",
  "RED",
  "PINK",
  "PURPLE",
]);

export const DEFAULT_STATUS_COLUMN_KEYS = [
  "Backlog",
  "Functional Refinement",
  "Technical Refinement",
  "In Progress",
  "In Tests",
  "In Revision",
  "Done",
];

/** @deprecated alias */
export const DEFAULT_STATUS_OPTIONS = DEFAULT_STATUS_COLUMN_KEYS;

export function normalizeProjectSelectColor(color, fallback = "GRAY") {
  if (!color) return fallback;
  const upper = String(color).trim().toUpperCase();
  return PROJECT_V2_SELECT_COLORS.has(upper) ? upper : fallback;
}

/** @returns {{ key: string, color: string, description: string } | null} */
export function normalizeStatusColumnEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const key = String(entry.key || entry.name || "").trim();
  if (!key) return null;
  const color = normalizeProjectSelectColor(entry.color, "GRAY");
  const description = typeof entry.description === "string" ? entry.description.trim() : "";
  return { key, color, description };
}

export function parseStatusColumnsCatalogJson(parsed) {
  if (!Array.isArray(parsed)) return [];
  const specs = [];
  const seen = new Set();
  for (const entry of parsed) {
    const spec = normalizeStatusColumnEntry(entry);
    if (!spec || seen.has(spec.key)) continue;
    seen.add(spec.key);
    specs.push(spec);
  }
  return specs;
}

export function resolveStatusColumnFilePath(cardsRoot, repoConfig, locale) {
  const statusColumnsFile = repoConfig.statusColumnsFile;
  if (!statusColumnsFile) return null;
  const resolvedFileName = statusColumnsFile.includes("{locale}")
    ? statusColumnsFile.replaceAll("{locale}", locale)
    : statusColumnsFile;
  return path.isAbsolute(resolvedFileName)
    ? resolvedFileName
    : path.join(cardsRoot, "config", resolvedFileName);
}

/** Map canonical keys to localized Project option names via optionMapByLocale. */
export function resolveStatusColumnSpecs(repoConfig, catalogSpecs, locale = "en") {
  const statusMap = repoConfig.optionMapByLocale?.[locale]?.status || {};
  return catalogSpecs.map((spec) => ({
    key: spec.key,
    name: statusMap[spec.key] || spec.key,
    color: spec.color,
    description: spec.description,
  }));
}

// ---------------------------------------------------------------------------
// Card frontmatter parsing (shared by GitHub-in-sync.mjs and all backends)
// ---------------------------------------------------------------------------

export function parseFrontmatter(content) {
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

export function extractTitleFromBody(body) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled";
}

export function parseCardFile(content, relativeFile) {
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

// ---------------------------------------------------------------------------
// Sub-issues detection from body (shared)
// ---------------------------------------------------------------------------

export function splitBodyLines(body) {
  return String(body || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
}

export function extractCardIdFromReference(text) {
  const value = String(text || "").trim();
  const linkMatch = value.match(/^\[([A-Z0-9][A-Z0-9_-]*)\s*(?:\(#\d+\))?\]/i);
  if (linkMatch) return linkMatch[1];
  const plainMatch = value.match(/^([A-Z0-9][A-Z0-9_-]*)/i);
  return plainMatch ? plainMatch[1] : value;
}

export function parseSubIssueIds(body) {
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
// Edge building (parent-child relationships) — shared
// ---------------------------------------------------------------------------

export function buildEdges(cards) {
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
// Issue title / description formatting — shared
// ---------------------------------------------------------------------------

export function buildIssueTitle(card) {
  const typeTag = card.type || "Story";
  const baseTitle = (card.title || "").replace(/^\[[^\]]+\]\s*/, "").trim();
  return `[${typeTag}] ${baseTitle || card.cardId}`;
}

export function buildJiraDescription(card) {
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

/** Reuse the same metadata block for idempotent search across backends (Jira/Azure/GitLab/Linear). */
export function buildRemoteDescriptionFromCard(card) {
  return buildJiraDescription(card);
}

// ---------------------------------------------------------------------------
// Field/option normalization — shared
// ---------------------------------------------------------------------------

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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

export function resolveMappedOptionValue(fieldKey, value, repoConfig) {
  if (!fieldKey || value === null || value === undefined) return value;
  const raw = String(value);
  const locale = repoConfig?.locale || "en";
  const directMap = repoConfig?.optionMap?.[fieldKey] || {};
  const localeMap = repoConfig?.optionMapByLocale?.[locale]?.[fieldKey] || {};
  return localeMap[raw] ?? directMap[raw] ?? value;
}

/** Inverse of resolveMappedOptionValue — localized Project option → canonical YAML value. */
export function canonicalizeRemoteOption(fieldKey, remoteValue, repoConfig) {
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

export function buildOptionCandidates(fieldKey, value, repoConfig) {
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

/** Map Hyperion card.status → remote state label via status_map (or identity). */
export function resolveMappedStatus(statusMap, hyperionStatus) {
  if (!hyperionStatus) return null;
  const map = statusMap && typeof statusMap === "object" ? statusMap : {};
  return map[hyperionStatus] || hyperionStatus;
}

// ---------------------------------------------------------------------------
// Reverse sync — SYNC_METADATA parsing and card markdown reconstruction
// (shared by GitHub-in-sync.mjs and all backend reverse-sync modules)
// ---------------------------------------------------------------------------

export function parseSyncMetadataFromDescription(description) {
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

export function parseIssueSummaryTypeTitle(summary) {
  const s = String(summary || "").trim();
  const m = s.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (!m) return { type: "Story", title: s || "Untitled" };
  return { type: m[1].trim(), title: m[2].trim() || "Untitled" };
}

export function yamlQuote(value) {
  const s = String(value ?? "");
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function yamlNullIfEmpty(value) {
  const s = String(value ?? "").trim();
  return s === "" ? "null" : yamlQuote(s);
}

export function yamlNullIfEmptyNumber(value) {
  const s = String(value ?? "").trim();
  if (s === "") return "null";
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : "null";
}

/** Build card markdown from SYNC_METADATA description (shared by Jira/Azure/GitLab/Linear/GitHub reverse). */
export function remoteIssueToCardMarkdown({ title, description, labels, statusOverride }) {
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

export function buildCardMarkdownFromMeta(meta, body) {
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

export function patchCardFrontmatter(existingContent, updates) {
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

export function frontmatterDiffers(existingContent, updates) {
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
export function remoteBoardSyncAt(issueOrItem) {
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

export function inverseStatusMap(statusMap) {
  const inv = {};
  for (const [hyperionStatus, remoteStatus] of Object.entries(statusMap || {})) {
    if (remoteStatus) inv[String(remoteStatus)] = hyperionStatus;
  }
  return inv;
}

export function resolveHyperionStatusFromRemote(remoteStatus, statusMap, repoConfig) {
  if (!remoteStatus) return null;
  const inv = inverseStatusMap(statusMap);
  if (inv[remoteStatus]) return inv[remoteStatus];

  const norm = normalizeText(remoteStatus);
  for (const [remote, hyperion] of Object.entries(inv)) {
    if (normalizeText(remote) === norm) return hyperion;
  }

  return canonicalizeRemoteOption("status", remoteStatus, repoConfig) || remoteStatus;
}

/** @deprecated alias — kept for backward-compat import from sync.mjs; implementation identical to resolveHyperionStatusFromRemote. */
export function canonicalizeLinearState(stateName, statusMap, repoConfig) {
  return resolveHyperionStatusFromRemote(stateName, statusMap, repoConfig);
}

export function frontmatterUpdatesFromConvertedMarkdown(converted) {
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

export async function loadStatusColumnsCatalog({ cardsRoot, repoConfig, projectLocale = null }) {
  const locale = repoConfig.locale || projectLocale || "en";
  const file = resolveStatusColumnFilePath(cardsRoot, repoConfig, locale);

  let rawSpecs = [];
  if (file) {
    try {
      const raw = await fs.readFile(file, "utf8");
      rawSpecs = parseStatusColumnsCatalogJson(JSON.parse(raw));
    } catch {
      rawSpecs = [];
    }
  }

  if (!rawSpecs.length) {
    rawSpecs = DEFAULT_STATUS_COLUMN_KEYS.map((key, index) => ({
      key,
      color: ["GRAY", "BLUE", "PURPLE", "YELLOW", "PINK", "ORANGE", "GREEN"][index] || "GRAY",
      description: "",
    }));
  }

  const overlay = await readOverlaySpecs(cardsRoot, STATUS_COLUMNS_OVERLAY_FILENAME, parseStatusColumnsCatalogJson);
  rawSpecs = mergeStatusColumnSpecs(rawSpecs, overlay.specs);

  const specs = resolveStatusColumnSpecs(repoConfig, rawSpecs, locale);
  return {
    locale,
    specs,
    keys: rawSpecs.map((s) => s.key),
    file: file || "(fallback)",
    overlayFile: overlay.file,
  };
}
