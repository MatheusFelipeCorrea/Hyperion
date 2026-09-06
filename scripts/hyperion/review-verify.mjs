#!/usr/bin/env node
/**
 * Verify a PR review markdown has required gates (verdict, summary, tests_ran).
 * Run: npm run hyperion:review-verify -- --review .github/plans/reviews/pr-1-review.md
 *      npm run hyperion:review-verify -- --latest
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordEvent } from "./telemetry-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

function usage() {
  console.log(`Usage:
  npm run hyperion:review-verify -- --review <path.md>
  npm run hyperion:review-verify -- --latest

Requires frontmatter/body: verdict, ## Summary, tests_ran (yes|no|skipped).
`);
}

function findLatestReview() {
  const dir = join(root, ".github/plans/reviews");
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

  let reviewPath = argValue("--review");
  if (process.argv.includes("--latest") || !reviewPath) {
    if (!reviewPath) reviewPath = findLatestReview();
  }
  if (!reviewPath) {
    console.error("No review specified and none under .github/plans/reviews/");
    usage();
    process.exit(1);
  }

  const abs = resolve(process.cwd(), reviewPath);
  if (!existsSync(abs)) {
    console.error(`Review not found: ${abs}`);
    process.exit(1);
  }

  const text = readFileSync(abs, "utf8");
  const fm = parseFrontmatter(text);
  let failed = 0;

  const verdict = fm.verdict || (text.match(/^verdict:\s*(\S+)/im) || [])[1];
  const allowed = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];
  if (!verdict || !allowed.includes(String(verdict).toUpperCase())) {
    console.error(
      `FAIL verdict: got "${verdict || "(missing)"}" (need APPROVE|REQUEST_CHANGES|COMMENT)`
    );
    failed++;
  } else {
    console.log(`OK verdict: ${verdict}`);
  }

  if (!/^##\s+Summary\b/m.test(text)) {
    console.error("FAIL: missing ## Summary");
    failed++;
  } else {
    console.log("OK ## Summary");
  }

  if (!/^##\s+Findings\b/im.test(text)) {
    console.error("FAIL: missing ## Findings");
    failed++;
  } else {
    console.log("OK ## Findings");
  }

  const testsRan =
    fm.tests_ran ||
    (text.match(/^\s*-\s*tests_ran:\s*(\S+)/im) || [])[1] ||
    (text.match(/^tests_ran:\s*(\S+)/im) || [])[1];
  const okRan = ["yes", "no", "skipped"].includes(String(testsRan || "").toLowerCase());
  if (!okRan) {
    console.error(
      `FAIL tests_ran: got "${testsRan || "(missing)"}" (need yes|no|skipped in frontmatter or body)`
    );
    failed++;
  } else {
    console.log(`OK tests_ran: ${testsRan}`);
  }

  if (!/^##\s+Test output\b/im.test(text) && String(testsRan).toLowerCase() === "yes") {
    console.warn("WARN: tests_ran=yes but no ## Test output section");
  }

  if (failed) {
    console.error(`\nreview-verify FAILED (${failed})`);
    process.exit(1);
  }
  recordEvent(root, "agent-gate", "review-verify");
  console.log("review-verify OK");
}

main();
