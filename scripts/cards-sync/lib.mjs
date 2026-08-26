import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

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
  await saveProjectToConfig(configPath, repositorySlug, {
    projectNumber: picked.number,
    projectOwner,
  });

  return {
    discovered: true,
    projectNumber: picked.number,
    projectTitle: picked.title,
    projectOwner,
  };
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
