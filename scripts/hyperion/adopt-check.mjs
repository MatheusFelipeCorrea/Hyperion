#!/usr/bin/env node
/**
 * Adopter-side companion to distribution-purity-check.mjs — but inverted.
 * distribution-purity-check.mjs protects THIS repo from ever carrying a
 * real vínculo (GitHub Project, real cards, personal paths). This script
 * protects an ADOPTER's repo from the opposite mistake: keeping Hyperion's
 * own maintainer identity after a manual `git clone` of the whole kit repo
 * (instead of `hyperion:upgrade --adopt`, which never copies these files —
 * see MANAGED_FILES in upgrade-lib.mjs).
 *
 * GETTING-STARTED.md lists 9 files that must never survive a manual clone
 * un-replaced: CODEOWNERS, .github/FUNDING.yml, LICENSE, CONTRIBUTING.md,
 * CODE_OF_CONDUCT.md, SECURITY.md, SUPPORT.md, .github/ISSUE_TEMPLATE/,
 * .github/PULL_REQUEST_TEMPLATE.md. A human checklist is exactly the kind
 * of thing that gets skipped once — this makes it a one-command check.
 *
 * Run: npm run hyperion:adopt-check
 *      npm run hyperion:adopt-check -- --root .
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAINTAINER_MARKERS = ["MatheusFelipeCorrea", "Hyperion Contributors"];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function readText(root, rel) {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function findMarker(text) {
  return MAINTAINER_MARKERS.find((m) => text.includes(m)) || null;
}

/** These 7 repo-level files must never keep Hyperion's own identity. */
export function checkNoLeakedMaintainerFiles(root, fail) {
  const files = [
    "LICENSE",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "SUPPORT.md",
    ".github/CODEOWNERS",
    ".github/FUNDING.yml",
  ];
  for (const rel of files) {
    const text = readText(root, rel);
    if (!text) continue; // not present — nothing to leak here
    const marker = findMarker(text);
    if (marker) {
      fail(
        rel,
        `still references Hyperion's own maintainer identity ("${marker}") — this is the kit's own repo config, replace or remove it before treating this as your product's repo`
      );
    }
  }
}

/** GitHub issue/PR templates copied as-is still point contributors at the kit's own repo. */
export function checkNoLeakedTemplates(root, fail) {
  const prTemplate = readText(root, ".github/PULL_REQUEST_TEMPLATE.md");
  if (prTemplate && findMarker(prTemplate)) {
    fail(
      ".github/PULL_REQUEST_TEMPLATE.md",
      "still references Hyperion's own identity — replace before using in your product"
    );
  }

  const dirRel = join(".github", "ISSUE_TEMPLATE");
  const dir = join(root, dirRel);
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = `${dirRel.replace(/\\/g, "/")}/${entry.name}`;
    const text = readText(root, rel);
    if (text && findMarker(text)) {
      fail(rel, "still references Hyperion's own identity — replace before using in your product");
    }
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
    ["no leaked maintainer identity in repo-level files", checkNoLeakedMaintainerFiles],
    ["no leaked identity in issue/PR templates", checkNoLeakedTemplates],
  ];

  for (const [label, fn] of checks) {
    const before = failed;
    await fn(root, fail);
    if (failed === before) ok(label);
  }

  if (failed) {
    console.error(
      `\nhyperion:adopt-check FAILED (${failed}) — these files still carry Hyperion's own identity, not yours. See GETTING-STARTED.md's "files never to copy" list.`
    );
    process.exit(1);
  }
  console.log("hyperion:adopt-check OK — no leftover Hyperion maintainer identity found");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(`FAIL: unexpected error — ${err.message}`);
    process.exit(1);
  });
}
