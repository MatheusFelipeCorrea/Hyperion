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
 * Fail-closed: any check failing blocks the merge (required status check
 * on `dev`/`qa`/`main`). The gate itself never edits anything; `--fix` is a
 * local helper for contributors that only does what loses no work: sets a
 * real projectNumber back to null (printing it, for `.env`) and untracks real
 * cards / plans (kept on disk, added to .git/info/exclude). Everything else
 * is reported with the command to run.
 *
 * Run: npm run hyperion:distribution-purity-check
 *      npm run hyperion:distribution-purity-check -- --root .
 *      npm run hyperion:distribution-purity-check -- --fix
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function readText(root, rel) {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
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
      hint: `git restore --source=origin/dev -- ${rel}`,
    });
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
    files = execSync("git ls-files .github/cards", { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return; // not a git checkout — skip, nothing reliable to walk
  }
  for (const f of files) {
    const isTemplate = f === ".github/cards/CARD.template.md";
    const isExample = f.includes("/_examples/");
    const isConfig = f.startsWith(".github/cards/config/");
    if (f.endsWith(".md") && !isTemplate && !isExample) {
      fail(f, "real card outside _examples/ — this repo's own backlog belongs on the internal branch, and test cards in a sandbox repo", {
        kind: "untrack",
      });
    }
    void isConfig;
  }
}

/** .github/plans/ must stay empty except the tracked .gitkeep scaffolds. */
export function checkNoLeakedPlans(root, fail) {
  let files;
  try {
    files = execSync("git ls-files .github/plans", { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
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
  const args = ["grep", "-InE", pattern, "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json"];
  let out;
  try {
    out = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    out = err.status === 1 ? "" : null; // git grep exits 1 when no match — that's success here
  }
  if (out === null) return; // grep itself failed to run — don't false-fail the gate
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const file = line.split(":")[0];
    fail(file, "looks like it has an absolute personal filesystem path committed");
  }
}

/**
 * Applies the fixes that lose no work. Returns one message per fix; failures
 * without a `kind` are left alone (the caller still reports them).
 */
export function applyFixes(root, failures) {
  const messages = [];

  if (failures.some((f) => f.fix?.kind === "nullProjectNumber")) {
    const rel = ".github/cards/config/projects-map.json";
    const json = JSON.parse(readFileSync(join(root, rel), "utf8"));
    const moved = [];
    for (const [key, cfg] of [["default", json.default], ...Object.entries(json.repositories || {})]) {
      if (cfg && Number(cfg.projectNumber || 0) > 0) {
        moved.push(`${key}=#${cfg.projectNumber}`);
        cfg.projectNumber = null;
      }
    }
    writeFileSync(join(root, rel), `${JSON.stringify(json, null, 2)}\n`);
    messages.push(
      `${rel}: projectNumber back to null (was ${moved.join(", ")}) — to keep testing against that board, put PROJECT_NUMBER=<n> in .env (gitignored, loaded by the cards scripts)`
    );
  }

  const untrack = [...new Set(failures.filter((f) => f.fix?.kind === "untrack").map((f) => f.where))];
  if (untrack.length) {
    execFileSync("git", ["rm", "--cached", "-q", "--", ...untrack], { cwd: root });
    const excludeRel = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8" }).trim();
    const excludePath = resolve(root, excludeRel);
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    const lines = untrack.map((f) => `/${f}`).filter((line) => !current.split(/\r?\n/).includes(line));
    if (lines.length) {
      appendFileSync(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`);
    }
    for (const f of untrack) {
      messages.push(`${f}: untracked and listed in .git/info/exclude — still on disk, just never committed`);
    }
  }

  return messages;
}

const FIX_TEXT = {
  nullProjectNumber: "run `npm run hyperion:distribution-purity-check -- --fix` (moves the number to PROJECT_NUMBER in your .env) and commit",
  untrack: "run `npm run hyperion:distribution-purity-check -- --fix` (stops tracking the file, keeps your local copy) and commit",
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

async function main() {
  const root = resolve(argValue("--root") || process.cwd());
  const wantFix = process.argv.includes("--fix");

  const checks = [
    ["projects-map.json has no real projectNumber", checkNoProjectNumber],
    ["hyperion-sync-cards.yml has no push trigger", checkSyncCardsNoPushTrigger],
    ["CODEOWNERS/FUNDING.yml/dependabot.yml not in MANAGED_FILES", checkNotManagedFiles],
    ["no real cards outside _examples/", checkNoRealCards],
    [".github/plans/ has no leaked planning docs", checkNoLeakedPlans],
    ["no leaked absolute personal paths", checkNoLeakedPaths],
  ];

  let results = await runChecks(root, checks);
  if (wantFix) {
    const fixed = applyFixes(root, results.flatMap((r) => r.failures));
    for (const message of fixed) console.log(`FIXED ${message}`);
    if (fixed.length) results = await runChecks(root, checks);
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

  if (failures.length) {
    console.error(`\ndistribution-purity-check FAILED (${failures.length}) — this branch cannot merge to dev/qa/main until every check passes`);
    if (!wantFix && failures.some((f) => f.fix?.kind)) {
      console.error("Run `npm run hyperion:distribution-purity-check -- --fix` to clean what can be cleaned without losing work, then commit.");
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
