#!/usr/bin/env node
/**
 * Kit-only coverage gate for the Hyperion repository itself (never shipped:
 * scripts/kit/ is outside hyperion:upgrade's managed dirs, and `kit:*` npm
 * scripts are not merged into products).
 *
 * Node's built-in coverage only reports files some test imported, so a script
 * nobody tests simply vanishes from the denominator. This adds every source
 * file under scripts/{hyperion,cards-sync,kit} that was never loaded as 0%
 * covered (all of its lines, the same unit Node uses), so the number is honest.
 *
 * Run: npm run kit:coverage                 # run the suite, report, enforce --min (default 95)
 *      npm run kit:coverage -- --min 90
 *      npm run kit:coverage -- --lcov coverage/lcov.info   # reuse an existing report
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SOURCE_DIRS = ["scripts/hyperion", "scripts/cards-sync", "scripts/kit"];
export const TEST_GLOBS = [
  "scripts/hyperion/*.test.mjs",
  "scripts/cards-sync/*.test.mjs",
  "scripts/cards-sync/backends/*.test.mjs",
  "scripts/kit/*.test.mjs",
];

/** Live-API end-to-end scripts are tests themselves, not code under test. */
export function isSourceFile(rel) {
  return rel.endsWith(".mjs") && !rel.endsWith(".test.mjs") && !rel.startsWith("scripts/cards-sync/e2e/");
}

export function normalizeSourcePath(file, root) {
  const unix = file.replace(/\\/g, "/");
  const base = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  return unix.startsWith(base) ? unix.slice(base.length) : unix.replace(/^.*?\/(scripts\/)/, "$1");
}

/** lcov text → [{ file, lf, lh }] (only LF/LH are needed for line coverage). */
export function parseLcov(text, root = "") {
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) cur = { file: normalizeSourcePath(line.slice(3), root), lf: 0, lh: 0 };
    else if (cur && line.startsWith("LF:")) cur.lf = Number(line.slice(3));
    else if (cur && line.startsWith("LH:")) cur.lh = Number(line.slice(3));
    else if (cur && line === "end_of_record") {
      files.push(cur);
      cur = null;
    }
  }
  return files;
}

/** Adds every source file the suite never loaded, with all lines uncovered. */
export function addUnmeasured(measured, sources, lineCount) {
  const seen = new Set(measured.map((f) => f.file));
  const kept = measured.filter((f) => isSourceFile(f.file));
  const missing = sources.filter((rel) => isSourceFile(rel) && !seen.has(rel));
  return [...kept, ...missing.map((file) => ({ file, lf: lineCount(file), lh: 0, unmeasured: true }))];
}

export function summarize(files, min) {
  const lf = files.reduce((s, f) => s + f.lf, 0);
  const lh = files.reduce((s, f) => s + f.lh, 0);
  const pct = lf ? (100 * lh) / lf : 100;
  const needed = Math.max(0, Math.ceil((min / 100) * lf) - lh);
  const gaps = files
    .filter((f) => f.lf && (100 * f.lh) / f.lf < min)
    .map((f) => ({ ...f, pct: (100 * f.lh) / f.lf, uncovered: f.lf - f.lh }))
    .sort((a, b) => b.uncovered - a.uncovered);
  return { lf, lh, pct, needed, ok: pct >= min, gaps };
}

export function formatReport(summary, min, { top = 15 } = {}) {
  const lines = [
    `Line coverage: ${summary.pct.toFixed(2)}% (${summary.lh}/${summary.lf}) — required ${min}%`,
  ];
  if (summary.gaps.length) {
    lines.push(`Files below ${min}% (${summary.gaps.length}), biggest gaps first:`);
    for (const g of summary.gaps.slice(0, top)) {
      const note = g.unmeasured ? "  (no test imports it)" : "";
      lines.push(`  ${String(g.uncovered).padStart(5)} lines uncovered  ${g.pct.toFixed(1).padStart(5)}%  ${g.file}${note}`);
    }
    if (summary.gaps.length > top) lines.push(`  … and ${summary.gaps.length - top} more`);
  }
  return lines.join("\n");
}

function markdownSummary(summary, min) {
  const rows = summary.gaps
    .slice(0, 25)
    .map((g) => `| \`${g.file}\` | ${g.pct.toFixed(1)}% | ${g.uncovered}${g.unmeasured ? " (not imported by any test)" : ""} |`);
  return [
    `### Kit coverage: ${summary.pct.toFixed(2)}% (required ${min}%) ${summary.ok ? "✅" : "❌"}`,
    "",
    summary.ok ? "" : `Cover **${summary.needed}** more lines to reach ${min}%.`,
    "",
    rows.length ? "| File | Lines covered | Uncovered lines |\n|---|---|---|\n" + rows.join("\n") : "",
    "",
  ].join("\n");
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function runSuite(root) {
  const dir = mkdtempSync(join(tmpdir(), "kit-coverage-"));
  const lcovPath = join(dir, "lcov.info");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-coverage",
      "--test-coverage-exclude=**/*.test.mjs",
      "--test-reporter=dot",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
      "--test",
      ...TEST_GLOBS,
    ],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] }
  );
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    console.error("::error title=Kit coverage::Tests failed — coverage is only measured on a green suite. Fix the failing tests above first (npm test).");
    process.exit(result.status || 1);
  }
  const text = readFileSync(lcovPath, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return text;
}

function main() {
  const root = resolve(argValue("--root") || process.cwd());
  const min = Number(argValue("--min") || 95);
  const lcovArg = argValue("--lcov");
  if (lcovArg && !existsSync(lcovArg)) {
    console.error(`::error title=Kit coverage::lcov file not found: ${lcovArg}`);
    process.exit(1);
  }
  const lcov = lcovArg ? readFileSync(lcovArg, "utf8") : runSuite(root);
  const sources = execFileSync("git", ["ls-files", ...SOURCE_DIRS.map((d) => `${d}/*.mjs`)], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  const files = addUnmeasured(parseLcov(lcov, root), sources, (rel) => readFileSync(join(root, rel), "utf8").split("\n").length);
  const summary = summarize(files, min);

  console.log(`\n${formatReport(summary, min)}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownSummary(summary, min));

  if (!summary.ok) {
    console.error(
      `\n::error title=Kit coverage below ${min}%::${summary.pct.toFixed(2)}% of the kit's lines are covered — cover ${summary.needed} more lines. ` +
        `Start with the files listed above (biggest gaps first; "no test imports it" means the file needs its first test). ` +
        `Reproduce locally: npm run kit:coverage`
    );
    process.exit(1);
  }
  console.log(`\nkit:coverage OK — ${summary.pct.toFixed(2)}% ≥ ${min}%`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
