#!/usr/bin/env node
/**
 * Verify a spec-review gate artifact has required verdict + sections.
 * Run: npm run hyperion:spec-review-verify -- --review .github/plans/reviews/PROJ-STORY-001-review.md
 *      npm run hyperion:spec-review-verify -- --latest
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  npm run hyperion:spec-review-verify -- --review <path.md>
  npm run hyperion:spec-review-verify -- --latest

Requires frontmatter/body: card_id, verdict (APPROVED|APPROVED WITH WARNINGS|BLOCKED),
## Summary, ## Checklist, ## Blocking issues, ## Recommended next step.

Note: this checks spec-review gate artifacts, not pr-reviewer artifacts (pr-*-review.md
files are covered by hyperion:review-verify instead).
`);
}

/** Spec-review and pr-reviewer both write into .github/plans/reviews/ — only
 * consider spec-review's own naming (anything NOT prefixed pr-<number>-review). */
function findLatestSpecReview() {
  const dir = join(root, ".github/plans/reviews");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith("-review.md") && !f.startsWith(".") && !/^pr-.+-review\.md$/i.test(f))
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
    if (!reviewPath) reviewPath = findLatestSpecReview();
  }
  if (!reviewPath) {
    console.error("No review specified and none found under .github/plans/reviews/ (spec-review naming)");
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

  const cardId = fm.card_id || (text.match(/^card_id:\s*(\S+)/im) || [])[1];
  if (!cardId) {
    console.error("FAIL card_id: missing (frontmatter card_id: <id>)");
    failed++;
  } else {
    console.log(`OK card_id: ${cardId}`);
  }

  const verdict = fm.verdict || (text.match(/^verdict:\s*(.+)$/im) || [])[1];
  const allowed = ["APPROVED", "APPROVED WITH WARNINGS", "BLOCKED"];
  const normalizedVerdict = String(verdict || "").trim().toUpperCase();
  if (!verdict || !allowed.includes(normalizedVerdict)) {
    console.error(
      `FAIL verdict: got "${verdict || "(missing)"}" (need APPROVED|APPROVED WITH WARNINGS|BLOCKED)`
    );
    failed++;
  } else {
    console.log(`OK verdict: ${verdict}`);
  }

  const requiredHeadings = [
    { label: "## Summary", re: /^##\s+Summary\b/m },
    { label: "## Checklist", re: /^##\s+Checklist\b/m },
    { label: "## Blocking issues", re: /^##\s+Blocking issues\b/im },
    { label: "## Recommended next step", re: /^##\s+Recommended next step\b/im },
  ];
  for (const h of requiredHeadings) {
    if (!h.re.test(text)) {
      console.error(`FAIL: missing ${h.label}`);
      failed++;
    } else {
      console.log(`OK ${h.label}`);
    }
  }

  if (normalizedVerdict === "BLOCKED") {
    // No "m" flag: with it, "$" would match end-of-line instead of end-of-string,
    // truncating the capture at the Blocking issues heading's own line.
    const blockingSection = text.match(/(?:^|\n)##\s+Blocking issues\b([\s\S]*?)(?=\n##\s|$)/i);
    const body = (blockingSection?.[1] || "").trim();
    if (!body || /^-\s*\.\.\.\s*$/.test(body) || /^none\.?$/i.test(body)) {
      console.error("FAIL: verdict is BLOCKED but ## Blocking issues has no listed issue");
      failed++;
    } else {
      console.log("OK: BLOCKED verdict has listed blocking issue(s)");
    }
  }

  if (failed) {
    console.error(`\nspec-review-verify FAILED (${failed})`);
    process.exit(1);
  }
  console.log("spec-review-verify OK");
}

main();
