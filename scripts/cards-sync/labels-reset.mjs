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

function listRepoLabels(owner, repo) {
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

function deleteLabel(owner, repo, name, dryRun) {
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

function ensureLabel(owner, repo, { name, color, description }, exists, dryRun) {
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

  const [owner, repo] = repositorySlug.split("/");
  const token = process.env.PROJECT_SYNC_TOKEN || process.env.GITHUB_TOKEN || detectTokenFromGhCli();
  if (!token) {
    log("ERROR: no GitHub token. Run: gh auth login");
    process.exit(1);
  }

  const config = (await readJsonIfExists(configPath)) || { default: {} };
  const repoConfig = resolveRepoConfig(config, repositorySlug);
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
  log(`Locale: ${locale} (${canonical.size} Hyperion labels, v2 catalog)`);
  log(`Keep Dependabot labels: ${keepDependabot ? "yes" : "no"}`);
  log("");

  const existing = listRepoLabels(owner, repo);
  const existingSet = new Set(existing);
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

  const toEnsure = catalog.specs.filter((spec) => !existingSet.has(spec.name));
  log(`Existing: ${existing.length} | Delete: ${toDelete.length} | Create: ${toEnsure.length} | Update metadata: ${catalog.specs.length - toEnsure.length}`);
  log("");

  if (toDelete.length) {
    log("Removing non-Hyperion labels...");
    for (const name of toDelete.sort()) deleteLabel(owner, repo, name, dryRun);
  }

  log("");
  log("Ensuring Hyperion catalog labels (color + description)...");
  for (const spec of [...catalog.specs].sort((a, b) => a.name.localeCompare(b.name))) {
    ensureLabel(owner, repo, spec, existingSet.has(spec.name), dryRun);
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
