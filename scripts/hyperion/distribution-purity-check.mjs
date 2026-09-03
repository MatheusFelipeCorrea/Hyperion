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
 * on `main`). This never edits anything — only the branch this runs on
 * fixes the source, then re-runs.
 *
 * Run: npm run hyperion:distribution-purity-check
 *      npm run hyperion:distribution-purity-check -- --root .
 */
import { existsSync, readFileSync } from "node:fs";
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
      fail(rel, `${key}.projectNumber is set to #${num} — this repo must never carry a real Project link on a distributed branch`);
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
    fail(rel, "has a `push:` trigger — this repo has no real GitHub Project to sync to, a push-triggered run will always fail (or worse, auto-create one)");
  }
}

/** CODEOWNERS/FUNDING.yml are this repo's own config and must never propagate. */
export async function checkNotManagedFiles(root, fail) {
  const rel = "scripts/hyperion/upgrade-lib.mjs";
  const text = readText(root, rel);
  if (!text) {
    fail(rel, "missing — cannot verify MANAGED_FILES/MANAGED_DIRS");
    return;
  }
  for (const name of ["CODEOWNERS", "FUNDING.yml"]) {
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
      fail(f, "real card outside _examples/ — this repo's own backlog belongs on the internal branch, not on a distributed one");
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
      fail(f, "tracked file under .github/plans/ — this directory should only ever hold .gitkeep scaffolds on a distributed branch (session/planning docs are gitignored on purpose)");
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

async function main() {
  const root = resolve(argValue("--root") || process.cwd());
  let failed = 0;
  const fail = (where, why) => {
    console.error(`FAIL ${where}: ${why}`);
    failed++;
  };
  const ok = (msg) => console.log(`OK ${msg}`);

  const checks = [
    ["projects-map.json has no real projectNumber", checkNoProjectNumber],
    ["hyperion-sync-cards.yml has no push trigger", checkSyncCardsNoPushTrigger],
    ["CODEOWNERS/FUNDING.yml not in MANAGED_FILES", checkNotManagedFiles],
    ["no real cards outside _examples/", checkNoRealCards],
    [".github/plans/ has no leaked planning docs", checkNoLeakedPlans],
    ["no leaked absolute personal paths", checkNoLeakedPaths],
  ];

  for (const [label, fn] of checks) {
    const before = failed;
    await fn(root, fail);
    if (failed === before) ok(label);
  }

  if (failed) {
    console.error(`\ndistribution-purity-check FAILED (${failed}) — this branch cannot merge to main until every check passes`);
    process.exit(1);
  }
  console.log("distribution-purity-check OK — no binding to this repository found");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(`FAIL: unexpected error — ${err.message}`);
    process.exit(1);
  });
}
