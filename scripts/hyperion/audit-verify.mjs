#!/usr/bin/env node
/**
 * Verify an audit-runner consolidated summary has required sections.
 * Run: npm run hyperion:audit-verify -- --summary .github/audits/results/_summary/audit-run-2026-08-21.md
 *      npm run hyperion:audit-verify -- --latest
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
  npm run hyperion:audit-verify -- --summary <path-to-audit-run-summary.md>
  npm run hyperion:audit-verify -- --latest [--root <repo-root>]

Checks the audit-runner consolidated summary (outputs.audits/_summary/audit-run-*.md)
has: ## Executive Summary, ## Reports (with a table row), ## Cross-cutting Themes,
## Recommended Priority Fixes.
`);
}

/** Read outputs.audits from project.yml, defaulting to .github/audits/results. */
function auditsRoot(repoRoot) {
  const ymlPath = join(repoRoot, ".github/project.yml");
  const fallback = join(repoRoot, ".github/audits/results");
  if (!existsSync(ymlPath)) return fallback;
  const text = readFileSync(ymlPath, "utf8");
  const m = text.match(/^\s*audits:\s*(.+)$/m);
  if (!m) return fallback;
  const rel = m[1].trim().replace(/^["']|["']$/g, "");
  if (!rel || rel === "null" || rel === "~") return fallback;
  return join(repoRoot, rel.replace(/^\.\//, ""));
}

function findLatestSummary(repoRoot) {
  const dir = join(auditsRoot(repoRoot), "_summary");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .map((f) => join(dir, f));
  if (!files.length) return null;
  files.sort();
  return files[files.length - 1];
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    process.exit(0);
  }

  const repoRoot = resolve(argValue("--root") || root);

  let summaryPath = argValue("--summary");
  if (process.argv.includes("--latest") || !summaryPath) {
    if (!summaryPath) summaryPath = findLatestSummary(repoRoot);
  }
  if (!summaryPath) {
    console.error(`No summary specified and none found under ${join(auditsRoot(repoRoot), "_summary")}`);
    usage();
    process.exit(1);
  }

  const abs = resolve(process.cwd(), summaryPath);
  if (!existsSync(abs)) {
    console.error(`Summary not found: ${abs}`);
    process.exit(1);
  }

  const text = readFileSync(abs, "utf8");
  let failed = 0;

  const requiredHeadings = [
    { label: "## Executive Summary", re: /^##\s+Executive Summary\b/im },
    { label: "## Reports", re: /^##\s+Reports\b/im },
    { label: "## Cross-cutting Themes", re: /^##\s+Cross-cutting Themes\b/im },
    { label: "## Recommended Priority Fixes", re: /^##\s+Recommended Priority Fixes\b/im },
  ];
  for (const h of requiredHeadings) {
    if (!h.re.test(text)) {
      console.error(`FAIL: missing ${h.label}`);
      failed++;
    } else {
      console.log(`OK ${h.label}`);
    }
  }

  // No "m" flag: with it, "$" would match end-of-line instead of end-of-string,
  // truncating the capture at the Reports heading's own line.
  const reportsSection = text.match(/(?:^|\n)##\s+Reports\b([\s\S]*?)(?=\n##\s|$)/i);
  const reportsBody = (reportsSection?.[1] || "").trim();
  if (reportsSection && !/\|.+\|/.test(reportsBody) && !/\[.+\]\(.+\)/.test(reportsBody)) {
    console.error("FAIL: ## Reports has no table row or link to a dimension report");
    failed++;
  } else if (reportsSection) {
    console.log("OK ## Reports lists dimension report(s)");
  }

  if (failed) {
    console.error(`\naudit-verify FAILED (${failed})`);
    process.exit(1);
  }
  console.log("audit-verify OK");
}

main();
