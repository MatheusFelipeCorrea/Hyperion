#!/usr/bin/env node
/**
 * Distribution purity gate — asserts this checkout carries NO binding to
 * this specific repository/maintainer before it's allowed onto `main`.
 *
 * Codifies what 10 rounds of manual audits kept finding by hand: a real
 * GitHub Project number, a personal CODEOWNERS/FUNDING propagated to
 * adopters, a push-triggered cards-sync workflow, real backlog cards, a
 * leaked absolute path, or an internal planning doc — any of these means
 * `main` isn't safe to `git clone`/`hyperion:upgrade` from.
 *
 * Kit-only: this file ships to products with scripts/hyperion, but a product
 * legitimately commits its cards and board binding, so outside the Hyperion
 * kit repo (see detectKit) it exits 0 without checking anything. In the kit
 * it runs from the kit-only `kit-purity.yml` workflow, never a `hyperion-*`
 * one (those are copied into products by hyperion:upgrade).
 *
 * Fail-closed: any check failing blocks the merge (required status check
 * on `dev`/`qa`/`main`). The gate itself never edits anything; `--fix` is a
 * local helper for contributors. It only prints the plan unless `--yes` is
 * given, refuses on the `internal` branch, and only does what loses no work:
 * sets a real projectNumber back to null (printing it, for `.env`) and
 * untracks real cards / plans after copying them to .git/hyperion-backup/
 * (kept on disk, added to .git/info/exclude). Everything else is reported
 * with the command to run.
 *
 * Run: npm run hyperion:distribution-purity-check
 *      npm run hyperion:distribution-purity-check -- --root .
 *      npm run hyperion:distribution-purity-check -- --fix          # plan only
 *      npm run hyperion:distribution-purity-check -- --fix --yes    # apply
 *      … --assume-kit   treat the checkout as the kit (tests / fixtures)
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";

const KIT_PACKAGE_NAME = "hyperion";
const KIT_REPOSITORY = /github\.com[/:]MatheusFelipeCorrea\/Hyperion(?:\.git)?\/?$/i;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function readText(root, rel) {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function git(root, args, opts = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts });
}

/** Tracked paths under `pathspec`, verbatim (no C-style quoting of non-ASCII names). */
export function gitLsFiles(root, pathspec) {
  return git(root, ["-c", "core.quotePath=false", "ls-files", "-z", "--", pathspec]).split("\0").filter(Boolean);
}

/**
 * Is `root` the Hyperion kit itself (or a fork of it)? Products upgraded by
 * hyperion:upgrade get `.github/hyperion-kit.json` and keep their own
 * package.json name/repository, so neither signal matches there.
 */
export function detectKit(root) {
  if (existsSync(join(root, ".github", "hyperion-kit.json"))) {
    return { isKit: false, reason: ".github/hyperion-kit.json found — this is a product upgraded from the kit" };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return { isKit: false, reason: "no readable package.json" };
  }
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url || "";
  if (pkg.name === KIT_PACKAGE_NAME && KIT_REPOSITORY.test(repo)) {
    return { isKit: true, reason: "package.json is the Hyperion kit's" };
  }
  return { isKit: false, reason: "package.json is not the Hyperion kit's (name/repository)" };
}

/** `upstream/dev` in a fork that has an `upstream` remote, `origin/dev` otherwise. */
export function devRef(root) {
  try {
    if (git(root, ["remote"]).split(/\r?\n/).includes("upstream")) return "upstream/dev";
  } catch {
    /* not a git checkout — fall through */
  }
  return "origin/dev";
}

export function currentBranch(root) {
  try {
    return git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  } catch {
    return "";
  }
}

/** projects-map.json must never carry a real, persisted GitHub Project link. */
export function checkNoProjectNumber(root, fail) {
  const rel = ".github/cards/config/projects-map.json";
  const text = readText(root, rel);
  if (!text) return; // no config at all — nothing to leak
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    fail(rel, `invalid JSON — ${err.message}`);
    return;
  }
  const entries = [["default", json.default], ...Object.entries(json.repositories || {})];
  for (const [key, cfg] of entries) {
    if (!cfg) continue;
    const num = Number(cfg.projectNumber || 0);
    if (num > 0) {
      fail(rel, `${key}.projectNumber is set to #${num} — this repo must never carry a real Project link on a distributed branch`, {
        kind: "nullProjectNumber",
      });
    }
  }
}

/** The kit's own sync-cards workflow must stay workflow_dispatch-only here. */
export function checkSyncCardsNoPushTrigger(root, fail) {
  const rel = ".github/workflows/hyperion-sync-cards.yml";
  const text = readText(root, rel);
  if (!text) return;
  // No /m flag: with it, `$` matches end-of-line (not end-of-string), so the
  // lazy [\s\S]*? lookahead would stop after the very first line every time.
  const onBlock = text.match(/(?:^|\n)on:\s*\n([\s\S]*?)(?=\n\S|$)/)?.[1] || "";
  if (/^\s*push:/m.test(onBlock)) {
    fail(rel, "has a `push:` trigger — this repo has no real GitHub Project to sync to, a push-triggered run will always fail (or worse, auto-create one)", {
      hint: `git restore --source=${devRef(root)} -- ${rel}`,
    });
  }
}

/** internal-*.yml workflows that legitimately live on main (they act on internal from there). */
export const DISTRIBUTED_INTERNAL_WORKFLOWS = new Set(["internal-sync.yml"]);

/**
 * internal-*.yml workflows and workflows triggered by a push to `internal`
 * only exist on that branch (the repo using its own kit). Finding one here
 * means internal was merged back.
 */
export function checkNoInternalOnlyWorkflows(root, fail) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const rel = `.github/workflows/${name}`;
    if (/^internal-/.test(name) && !DISTRIBUTED_INTERNAL_WORKFLOWS.has(name)) {
      fail(rel, "internal-*.yml workflows only exist on the `internal` branch — internal-only files never leave that branch (internal only pulls from main)");
      continue;
    }
    let doc;
    try {
      doc = load(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue; // malformed YAML is actionlint's job, not this gate's
    }
    const branches = [doc?.on?.push?.branches].flat().filter(Boolean);
    if (branches.includes("internal")) {
      fail(rel, "runs on push to `internal` — internal-only files never leave that branch (internal only pulls from main)");
    }
  }
}

/** CODEOWNERS/FUNDING.yml/dependabot.yml are this repo's own config and must never propagate. */
export async function checkNotManagedFiles(root, fail) {
  const rel = "scripts/hyperion/upgrade-lib.mjs";
  const text = readText(root, rel);
  if (!text) {
    fail(rel, "missing — cannot verify MANAGED_FILES/MANAGED_DIRS");
    return;
  }
  for (const name of ["CODEOWNERS", "FUNDING.yml", "dependabot.yml"]) {
    if (new RegExp(`["'\`][^"'\`]*${name}["'\`]`).test(text)) {
      fail(rel, `.github/${name} appears to be listed as managed — it must stay repo-own config, never propagated via hyperion:upgrade`);
    }
  }
}

/** No real backlog cards — only the template and _examples/ ship on a distributed branch. */
export function checkNoRealCards(root, fail) {
  const cardsDir = join(root, ".github", "cards");
  if (!existsSync(cardsDir)) return;
  let files;
  try {
    files = gitLsFiles(root, ".github/cards");
  } catch {
    return; // not a git checkout — skip, nothing reliable to walk
  }
  for (const f of files) {
    const isTemplate = f === ".github/cards/CARD.template.md";
    const isExample = f.includes("/_examples/");
    if (f.endsWith(".md") && !isTemplate && !isExample) {
      fail(f, "real card outside _examples/ — this repo's own backlog belongs on the internal branch, and test cards in a sandbox repo", {
        kind: "untrack",
      });
    }
  }
}

/** .github/plans/ must stay empty except the tracked .gitkeep scaffolds. */
export function checkNoLeakedPlans(root, fail) {
  let files;
  try {
    files = gitLsFiles(root, ".github/plans");
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".gitkeep")) {
      fail(f, "tracked file under .github/plans/ — this directory should only ever hold .gitkeep scaffolds on a distributed branch (session/planning docs are gitignored on purpose)", {
        kind: "untrack",
      });
    }
  }
}

/** No absolute personal filesystem paths committed anywhere. */
export function checkNoLeakedPaths(root, fail) {
  const pattern = String.raw`C:\\+Users\\+|/home/[a-zA-Z0-9_-]+/|/Users/[a-zA-Z0-9_-]+/`;
  const args = ["-c", "core.quotePath=false", "grep", "-z", "-InE", pattern, "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json"];
  let out;
  try {
    out = git(root, args);
  } catch (err) {
    out = err.status === 1 ? "" : null; // git grep exits 1 when no match — that's success here
  }
  if (out === null) return; // grep itself failed to run — don't false-fail the gate
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    fail(line.split("\0")[0], "looks like it has an absolute personal filesystem path committed");
  }
}

/**
 * One `.git/info/exclude` line matching exactly this tracked path: anchored
 * with a leading `/`, glob metacharacters and `!`/`#` escaped, trailing
 * spaces kept.
 */
export function excludePattern(rel) {
  const escaped = rel.replace(/[\\*?[\]!#]/g, "\\$&").replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
  return `/${escaped}`;
}

/** What `--fix` would do, without touching anything. */
export function planFixes(root, failures) {
  const plan = { projectNumbers: [], untrack: [] };
  if (failures.some((f) => f.fix?.kind === "nullProjectNumber")) {
    const json = JSON.parse(readFileSync(join(root, ".github/cards/config/projects-map.json"), "utf8"));
    for (const [key, cfg] of [["default", json.default], ...Object.entries(json.repositories || {})]) {
      if (cfg && Number(cfg.projectNumber || 0) > 0) plan.projectNumbers.push(`${key}=#${cfg.projectNumber}`);
    }
  }
  plan.untrack = [...new Set(failures.filter((f) => f.fix?.kind === "untrack").map((f) => f.where))];
  return plan;
}

function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Applies the fixes that lose no work. Every file about to be untracked is
 * first copied to `<git-common-dir>/hyperion-backup/<stamp>/<path>` — git
 * never reads or cleans that folder, so the copy survives a rebase/squash/
 * cherry-pick of the untracking commit, a checkout across it, or
 * `git clean -X`, any of which can delete the working-tree file.
 * Returns `{ messages, backupDir, excludePath }`.
 */
export function applyFixes(root, failures, { stamp = backupStamp() } = {}) {
  const messages = [];
  const plan = planFixes(root, failures);
  let backupDir = null;
  let excludePath = null;

  if (plan.projectNumbers.length) {
    const rel = ".github/cards/config/projects-map.json";
    const json = JSON.parse(readFileSync(join(root, rel), "utf8"));
    for (const [, cfg] of [["default", json.default], ...Object.entries(json.repositories || {})]) {
      if (cfg && Number(cfg.projectNumber || 0) > 0) cfg.projectNumber = null;
    }
    writeFileSync(join(root, rel), `${JSON.stringify(json, null, 2)}\n`);
    messages.push(
      `${rel}: projectNumber back to null (was ${plan.projectNumbers.join(", ")}) — to keep testing against that board, put PROJECT_NUMBER=<n> in .env (gitignored, loaded by the cards scripts)`
    );
  }

  if (plan.untrack.length) {
    const commonDir = resolve(root, git(root, ["rev-parse", "--git-common-dir"]).trim());
    backupDir = join(commonDir, "hyperion-backup", stamp);
    for (const f of plan.untrack) {
      const dest = join(backupDir, ...f.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      const src = join(root, ...f.split("/"));
      if (existsSync(src)) copyFileSync(src, dest);
      else writeFileSync(dest, execFileSync("git", ["show", `:${f}`], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }));
    }

    execFileSync("git", ["rm", "--cached", "-q", "--", ...plan.untrack], { cwd: root });

    excludePath = resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]).trim());
    mkdirSync(dirname(excludePath), { recursive: true });
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    const existing = new Set(current.split(/\r?\n/));
    const lines = plan.untrack.map(excludePattern).filter((line) => !existing.has(line));
    if (lines.length) {
      appendFileSync(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`);
    }
    for (const f of plan.untrack) {
      messages.push(`${f}: untracked and listed in .git/info/exclude — still on disk, just never committed`);
    }
  }

  return { messages, backupDir, excludePath };
}

export function recoveryText(backupDir, excludePath) {
  return [
    `Backup of every untracked file: ${backupDir}`,
    "Git never touches that folder. Rebasing, squashing or cherry-picking the commit that untracks these files,",
    "checking out across it, or `git clean -X` can delete the working copies — restore them from the backup:",
    `  POSIX:      cp -R "${backupDir}/." .`,
    `  PowerShell: Copy-Item -Recurse -Force "${backupDir}\\*" .`,
    `To track a file again: delete its line from ${excludePath} and \`git add\` it.`,
    "Delete the backup folder yourself once you no longer need it.",
  ].join("\n");
}

const FIX_TEXT = {
  nullProjectNumber:
    "run `npm run hyperion:distribution-purity-check -- --fix` to preview, add `--yes` to apply (moves the number to PROJECT_NUMBER in your .env), then commit",
  untrack:
    "run `npm run hyperion:distribution-purity-check -- --fix` to preview, add `--yes` to apply (stops tracking the file, keeps your local copy and a backup), then commit",
};

/** GitHub Actions error annotation pinned to the file (no-op outside Actions). */
function annotate(message, file) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  const fileProp = file && /[./]/.test(file) ? `,file=${prop(file.replace(/\\/g, "/"))}` : "";
  console.error(`::error title=${prop("Binding to the Hyperion repo")}${fileProp}::${esc(message)}`);
}

async function runChecks(root, checks) {
  const results = [];
  for (const [label, fn] of checks) {
    const failures = [];
    await fn(root, (where, why, fix = null) => failures.push({ where, why, fix }));
    results.push({ label, failures });
  }
  return results;
}

function printPlan(plan) {
  console.log("--fix plan (nothing changed yet):");
  if (plan.projectNumbers.length) {
    console.log(`  - set projectNumber back to null in .github/cards/config/projects-map.json (${plan.projectNumbers.join(", ")})`);
  }
  for (const f of plan.untrack) {
    console.log(`  - back up to .git/hyperion-backup/, then untrack and add to .git/info/exclude: ${f}`);
  }
  console.log("Re-run with `--fix --yes` to apply.");
}

async function main() {
  const root = resolve(argValue("--root") || process.cwd());
  const wantFix = process.argv.includes("--fix");
  const yes = process.argv.includes("--yes");

  const kit = process.argv.includes("--assume-kit") ? { isKit: true } : detectKit(root);
  if (!kit.isKit) {
    console.log(`INFO distribution-purity-check: not the Hyperion kit repository (${kit.reason}) — nothing to check.`);
    console.log("     This gate only guards the kit's own distributable branches; your repo's cards and board binding are yours to commit.");
    return;
  }

  if (wantFix && currentBranch(root) === "internal") {
    console.error("FAIL --fix refused on branch `internal` — that branch is where the kit's own backlog and board binding live.");
    process.exit(1);
  }

  const checks = [
    ["projects-map.json has no real projectNumber", checkNoProjectNumber],
    ["hyperion-sync-cards.yml has no push trigger", checkSyncCardsNoPushTrigger],
    ["no internal-only workflow (internal-*.yml or push to internal)", checkNoInternalOnlyWorkflows],
    ["CODEOWNERS/FUNDING.yml/dependabot.yml not in MANAGED_FILES", checkNotManagedFiles],
    ["no real cards outside _examples/", checkNoRealCards],
    [".github/plans/ has no leaked planning docs", checkNoLeakedPlans],
    ["no leaked absolute personal paths", checkNoLeakedPaths],
  ];

  let results = await runChecks(root, checks);
  let recovery = null;
  if (wantFix) {
    const all = results.flatMap((r) => r.failures);
    const plan = planFixes(root, all);
    if (!plan.projectNumbers.length && !plan.untrack.length) {
      console.log("--fix: nothing here can be fixed automatically.");
    } else if (!yes) {
      printPlan(plan);
    } else {
      const { messages, backupDir, excludePath } = applyFixes(root, all);
      for (const message of messages) console.log(`FIXED ${message}`);
      if (backupDir) recovery = recoveryText(backupDir, excludePath);
      results = await runChecks(root, checks);
    }
  }

  const failures = results.flatMap((r) => r.failures);
  for (const { label, failures: own } of results) {
    if (!own.length) console.log(`OK ${label}`);
    for (const { where, why, fix } of own) {
      console.error(`FAIL ${where}: ${why}`);
      if (fix?.hint) console.error(`     fix: ${fix.hint}`);
      annotate(`${why} — ${FIX_TEXT[fix?.kind] || fix?.hint || "remove the binding to this repository from the branch"}`, where);
    }
  }
  if (recovery) console.log(`\n${recovery}`);

  if (failures.length) {
    console.error(`\ndistribution-purity-check FAILED (${failures.length}) — this branch cannot merge to dev/qa/main until every check passes`);
    if (!wantFix && failures.some((f) => f.fix?.kind)) {
      console.error("Run `npm run hyperion:distribution-purity-check -- --fix` to preview what can be cleaned without losing work (add `--yes` to apply), then commit.");
    }
    process.exit(1);
  }
  console.log(
    wantFix
      ? "distribution-purity-check OK — review `git status` and commit the cleanup"
      : "distribution-purity-check OK — no binding to this repository found"
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(`FAIL: unexpected error — ${err.message}`);
    annotate(`distribution-purity-check crashed: ${err.message} — likely a Hyperion bug; open an issue with the log.`);
    process.exit(1);
  });
}
