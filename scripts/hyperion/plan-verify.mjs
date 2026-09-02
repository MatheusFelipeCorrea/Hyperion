#!/usr/bin/env node
/**
 * Verify an implementation plan (pre-execution artifact from the implementation-plan
 * agent) is structurally well-formed: frontmatter + at least one Phase + a
 * Verification section. Complements phase-verify.mjs, which checks *completion*
 * (tests_result: PASS) of phases after /execute runs — this checks the plan itself
 * is well-formed before execution starts.
 *
 * Run: npm run hyperion:plan-verify -- --plan .github/plans/implementations/feature-x-1.md
 *      npm run hyperion:plan-verify -- --latest
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

function usage() {
  console.log(`Usage:
  npm run hyperion:plan-verify -- --plan <path-to-plan.md>
  npm run hyperion:plan-verify -- --latest

Checks the plan has frontmatter (goal, card_id, status), at least one "### Phase"
section, and a Verification section (## 7. Verification or ## Verification).
`);
}

function findLatestPlan() {
  const dir = join(root, ".github/plans/implementations");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .map((f) => join(dir, f));
  if (!files.length) return null;
  files.sort();
  return files[files.length - 1];
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    process.exit(0);
  }

  let planPath = argValue("--plan");
  if (process.argv.includes("--latest") || !planPath) {
    if (!planPath) planPath = findLatestPlan();
  }
  if (!planPath) {
    console.error("No plan specified and none found under .github/plans/implementations/");
    usage();
    process.exit(1);
  }

  const abs = resolve(process.cwd(), planPath);
  if (!existsSync(abs)) {
    console.error(`Plan not found: ${abs}`);
    process.exit(1);
  }

  const text = readFileSync(abs, "utf8");
  const fm = parseFrontmatter(text);
  let failed = 0;

  if (!Object.keys(fm).length) {
    console.error("FAIL: no frontmatter block found (--- ... ---)");
    failed++;
  } else {
    for (const field of ["goal", "card_id"]) {
      if (!fm[field]) {
        console.error(`FAIL frontmatter: missing "${field}:"`);
        failed++;
      } else {
        console.log(`OK frontmatter.${field}: ${fm[field]}`);
      }
    }

    const status = fm.status;
    const allowedStatus = ["Completed", "In progress", "Planned", "Deprecated", "On Hold"];
    if (!status || !allowedStatus.includes(status)) {
      console.error(
        `FAIL frontmatter.status: got "${status || "(missing)"}" (need one of ${allowedStatus.join(" | ")})`
      );
      failed++;
    } else {
      console.log(`OK frontmatter.status: ${status}`);
    }
  }

  const phaseHeadings = [...text.matchAll(/^###\s+Phase\s+\S+/gim)];
  if (!phaseHeadings.length) {
    console.error('FAIL: no "### Phase N" section found — plan has no implementation phases');
    failed++;
  } else {
    console.log(`OK: ${phaseHeadings.length} phase section(s) found`);
  }

  if (!/^##\s+(?:\d+\.\s*)?Verification\b/im.test(text)) {
    console.error("FAIL: missing Verification section (## Verification or ## 7. Verification)");
    failed++;
  } else {
    console.log("OK Verification section present");
  }

  if (failed) {
    console.error(`\nplan-verify FAILED (${failed})`);
    process.exit(1);
  }
  console.log("plan-verify OK");
}

main();
