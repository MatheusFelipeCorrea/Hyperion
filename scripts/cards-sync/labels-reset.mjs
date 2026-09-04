import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import {
  detectRepoFromGit,
  detectTokenFromGhCli,
  readJsonIfExists,
  resolveRepoConfig,
  detectProjectLocaleFromYml,
  loadLabelsCatalog,
} from "./lib.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const hyperionPaths = resolveHyperionPaths(process.cwd());
const workspaceRoot = hyperionPaths.workspaceRoot;
const cardsRoot = hyperionPaths.cardsRoot;
const configPath = path.join(cardsRoot, "config", "projects-map.json");
const projectYmlPath = hyperionPaths.projectYmlPath;

const argYes = process.argv.includes("--yes");
const argDryRun = process.argv.includes("--dry-run");

/** Same detection sync.mjs/doctor.mjs use: explicit config wins, else scan
 * project.yml's management.backend, else default to github. */
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

/** GitHub default labels shipped with new repositories. */
const GITHUB_DEFAULT_LABELS = new Set([
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
]);

/** Automation labels — kept unless --no-keep-dependabot. */
const DEPENDABOT_LABELS = new Set(["dependencies", "github_actions"]);

/** Card type/priority belong on Project fields, not issue labels. */
const PROJECT_FIELD_LABEL_LEAKS = new Set([
  "Epic",
  "Feature",
  "Story",
  "Task",
  "Subtask",
  "Highest",
  "High",
  "Medium",
  "Low",
  "Priority: Highest",
  "Priority: High",
  "Priority: Medium",
  "Priority: Low",
]);

function log(msg) {
  console.log(`[labels-reset] ${msg}`);
}

function listRepoLabelsGitHub(owner, repo) {
  try {
    const out = execSync(`gh label list --repo ${owner}/${repo} --limit 200 --json name`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    return parsed.map((row) => row.name);
  } catch (error) {
    throw new Error(`Failed to list labels: ${error.message}`);
  }
}

function deleteLabelGitHub(owner, repo, name, dryRun) {
  if (dryRun) {
    log(`  (dry-run) delete: ${name}`);
    return;
  }
  try {
    execSync(`gh label delete ${JSON.stringify(name)} --repo ${owner}/${repo} --yes`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    log(`  deleted: ${name}`);
  } catch (error) {
    log(`  WARN: could not delete "${name}": ${error.stderr?.toString?.() || error.message}`);
  }
}

function ensureLabelGitHub(owner, repo, { name, color, description }, exists, dryRun) {
  if (dryRun) {
    const action = exists ? "edit" : "create";
    log(`  (dry-run) ${action}: ${name} (#${color})`);
    return;
  }
  try {
    if (exists) {
      execSync(
        `gh label edit ${JSON.stringify(name)} --repo ${owner}/${repo} --color ${color} --description ${JSON.stringify(description || "")}`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      );
      log(`  updated: ${name}`);
    } else {
      execSync(
        `gh label create ${JSON.stringify(name)} --repo ${owner}/${repo} --color ${color} --description ${JSON.stringify(description || "")} --force`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      );
      log(`  ensured: ${name}`);
    }
  } catch (error) {
    log(`  WARN: could not ensure "${name}": ${error.stderr?.toString?.() || error.message}`);
  }
}

// ---------------------------------------------------------------------------
// GitLab — same catalog-reset policy, over GitLab's Labels REST API instead
// of the `gh` CLI. GitLab projects ship with no default labels (unlike
// GitHub), so there's no GITHUB_DEFAULT_LABELS-style special case — any
// label outside the Hyperion catalog (and not kept for CI automation) is
// still an orphan under the same "canonical set only" policy.
// ---------------------------------------------------------------------------

async function gitlabFetch(gitlabBase, token, endpoint, method = "GET", body = undefined) {
  const response = await fetch(`${gitlabBase}${endpoint}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": token,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GitLab request failed (${response.status}): ${text}`);
  }
  return payload;
}

async function listProjectLabelsGitLab(gitlabBase, token, projectId) {
  const labels = [];
  let page = 1;
  while (true) {
    const batch = await gitlabFetch(
      gitlabBase,
      token,
      `/api/v4/projects/${encodeURIComponent(projectId)}/labels?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || !batch.length) break;
    labels.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return labels.map((l) => l.name);
}

async function deleteLabelGitLab(gitlabBase, token, projectId, name, dryRun) {
  if (dryRun) {
    log(`  (dry-run) delete: ${name}`);
    return;
  }
  try {
    await gitlabFetch(
      gitlabBase,
      token,
      `/api/v4/projects/${encodeURIComponent(projectId)}/labels/${encodeURIComponent(name)}`,
      "DELETE"
    );
    log(`  deleted: ${name}`);
  } catch (error) {
    log(`  WARN: could not delete "${name}": ${error.message}`);
  }
}

async function ensureLabelGitLab(gitlabBase, token, projectId, { name, color, description }, exists, dryRun) {
  const hexColor = color.startsWith("#") ? color : `#${color}`;
  if (dryRun) {
    const action = exists ? "edit" : "create";
    log(`  (dry-run) ${action}: ${name} (${hexColor})`);
    return;
  }
  try {
    if (exists) {
      await gitlabFetch(
        gitlabBase,
        token,
        `/api/v4/projects/${encodeURIComponent(projectId)}/labels/${encodeURIComponent(name)}`,
        "PUT",
        { color: hexColor, description: description || "" }
      );
      log(`  updated: ${name}`);
    } else {
      await gitlabFetch(gitlabBase, token, `/api/v4/projects/${encodeURIComponent(projectId)}/labels`, "POST", {
        name,
        color: hexColor,
        description: description || "",
      });
      log(`  ensured: ${name}`);
    }
  } catch (error) {
    log(`  WARN: could not ensure "${name}": ${error.message}`);
  }
}

function diffLabels(existing, canonical, keepDependabot) {
  const toDelete = [];
  for (const name of existing) {
    const lower = name.toLowerCase();
    if (canonical.has(name)) continue;
    if (keepDependabot && DEPENDABOT_LABELS.has(name)) continue;
    if (GITHUB_DEFAULT_LABELS.has(lower)) {
      toDelete.push(name);
      continue;
    }
    if (PROJECT_FIELD_LABEL_LEAKS.has(name)) {
      toDelete.push(name);
      continue;
    }
    toDelete.push(name);
  }
  return toDelete;
}

async function resetGitHubLabels({ repositorySlug, repoConfig, projectLocale, catalog, canonical, keepDependabot, dryRun }) {
  const [owner, repo] = repositorySlug.split("/");
  const token = process.env.PROJECT_SYNC_TOKEN || process.env.GITHUB_TOKEN || detectTokenFromGhCli();
  if (!token) {
    log("ERROR: no GitHub token. Run: gh auth login");
    process.exit(1);
  }

  const existing = listRepoLabelsGitHub(owner, repo);
  const existingSet = new Set(existing);
  const toDelete = diffLabels(existing, canonical, keepDependabot);
  const toEnsure = catalog.specs.filter((spec) => !existingSet.has(spec.name));
  log(`Existing: ${existing.length} | Delete: ${toDelete.length} | Create: ${toEnsure.length} | Update metadata: ${catalog.specs.length - toEnsure.length}`);
  log("");

  if (toDelete.length) {
    log("Removing non-Hyperion labels...");
    for (const name of toDelete.sort()) deleteLabelGitHub(owner, repo, name, dryRun);
  }

  log("");
  log("Ensuring Hyperion catalog labels (color + description)...");
  for (const spec of [...catalog.specs].sort((a, b) => a.name.localeCompare(b.name))) {
    ensureLabelGitHub(owner, repo, spec, existingSet.has(spec.name), dryRun);
  }
}

async function resetGitLabLabels({ repoConfig, catalog, canonical, keepDependabot, dryRun }) {
  const gitlabBase = String(process.env.GITLAB_URL || repoConfig.url || "https://gitlab.com").replace(/\/+$/, "");
  const projectId = process.env.GITLAB_PROJECT_ID || repoConfig.project_id || null;
  const token = process.env.GITLAB_TOKEN || null;
  if (!projectId || !token) {
    log("ERROR: GitLab backend needs GITLAB_PROJECT_ID and GITLAB_TOKEN (optional GITLAB_URL).");
    process.exit(1);
  }

  const existing = await listProjectLabelsGitLab(gitlabBase, token, projectId);
  const existingSet = new Set(existing);
  const toDelete = diffLabels(existing, canonical, keepDependabot);
  const toEnsure = catalog.specs.filter((spec) => !existingSet.has(spec.name));
  log(`Existing: ${existing.length} | Delete: ${toDelete.length} | Create: ${toEnsure.length} | Update metadata: ${catalog.specs.length - toEnsure.length}`);
  log("");

  if (toDelete.length) {
    log("Removing non-Hyperion labels...");
    for (const name of toDelete.sort()) await deleteLabelGitLab(gitlabBase, token, projectId, name, dryRun);
  }

  log("");
  log("Ensuring Hyperion catalog labels (color + description)...");
  for (const spec of [...catalog.specs].sort((a, b) => a.name.localeCompare(b.name))) {
    await ensureLabelGitLab(gitlabBase, token, projectId, spec, existingSet.has(spec.name), dryRun);
  }
}

async function main() {
  const keepDependabot = !process.argv.includes("--no-keep-dependabot");
  const dryRun = argDryRun || !argYes;

  if (dryRun && !argDryRun) {
    log("Dry-run mode (pass --yes to apply). Preview only.");
  }

  const repositorySlug = process.env.GITHUB_REPOSITORY || detectRepoFromGit();
  if (!repositorySlug) {
    log("ERROR: cannot detect repository from git remote.");
    process.exit(1);
  }

  const config = (await readJsonIfExists(configPath)) || { default: {} };
  const repoConfig = resolveRepoConfig(config, repositorySlug);
  const backend = await detectBackend(repoConfig);

  if (backend === "azure" || backend === "azure-devops") {
    log("Backend is Azure DevOps — nothing to reset here.");
    log("Azure DevOps work item Tags are free-text (System.Tags) with no color/description/catalog");
    log("concept in the REST API, unlike GitHub/GitLab labels. There's no orphan-cleanup or");
    log("metadata-drift problem this tool exists to solve for that backend.");
    process.exit(0);
  }

  if (backend === "linear") {
    log("Backend is Linear — nothing to reset here.");
    log("Linear issue labels are pushed and get-or-created directly during forward sync");
    log("(card.categories -> Linear IssueLabel, created on first use if missing) — see");
    log("runForwardSyncLinear in scripts/cards-sync/backends/linear.mjs. There's no separate");
    log("stale-default cleanup problem this tool exists to solve for that backend.");
    process.exit(0);
  }

  if (backend !== "github" && backend !== "gitlab") {
    log(`Backend "${backend}" not recognized for label reset. Supported: github, gitlab.`);
    process.exit(1);
  }

  const projectLocale = await detectProjectLocaleFromYml(projectYmlPath);
  if (projectLocale && !repoConfig.locale) repoConfig.locale = projectLocale;

  const catalog = await loadLabelsCatalog({
    cardsRoot,
    repoConfig,
    projectLocale,
  });
  const canonical = new Set(catalog.names);
  const locale = catalog.locale || repoConfig.locale || "en";

  if (!canonical.size) {
    log(`ERROR: no labels loaded (locale=${locale}, file=${catalog.file || "?"})`);
    process.exit(1);
  }

  log(`Repository: ${repositorySlug}`);
  log(`Backend: ${backend}`);
  log(`Locale: ${locale} (${canonical.size} Hyperion labels, v2 catalog)`);
  log(`Keep Dependabot labels: ${keepDependabot ? "yes" : "no"}`);
  log("");

  if (backend === "gitlab") {
    await resetGitLabLabels({ repoConfig, catalog, canonical, keepDependabot, dryRun });
  } else {
    await resetGitHubLabels({ repositorySlug, repoConfig, projectLocale, catalog, canonical, keepDependabot, dryRun });
  }

  log("");
  if (dryRun) {
    log("Dry-run complete. Re-run with --yes to apply.");
  } else {
    log("Label reset complete.");
  }
}

main().catch((error) => {
  console.error("[labels-reset] FATAL:", error.message);
  process.exit(1);
});
