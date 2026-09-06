#!/usr/bin/env node
/**
 * Compares two audit-runner consolidated summaries (results/_summary/audit-run-*.md)
 * dimension by dimension, using the same "## Reports" table audit-verify.mjs
 * already requires every summary to have — so this only ever needs to
 * understand one structural contract, already enforced elsewhere.
 *
 * Run: npm run hyperion:audit-diff                 # two most recent rounds
 *      npm run hyperion:audit-diff -- --json
 *      npm run hyperion:audit-diff -- --from <path> --to <path>
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
  npm run hyperion:audit-diff                       # diff the two most recent rounds
  npm run hyperion:audit-diff -- --json
  npm run hyperion:audit-diff -- --from <path> --to <path>
  npm run hyperion:audit-diff -- --root <repo-root>

Compares two audit-runner consolidated summaries dimension by dimension,
using the "## Reports" table (Dimension | Report | Findings) every summary
already carries (audit-verify.mjs requires it).
`);
}

/** Same lookup audit-verify.mjs uses: outputs.audits in project.yml, else the default. */
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

export function findSummaries(summaryDir) {
  if (!existsSync(summaryDir)) return [];
  return readdirSync(summaryDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .map((f) => join(summaryDir, f))
    .sort();
}

/** Parses the "## Reports" table into { dimension, report, findings } rows. */
export function parseReportsTable(text) {
  const section = text.match(/(?:^|\n)##\s+Reports\b([\s\S]*?)(?=\n##\s|$)/i);
  const body = section?.[1] || "";
  const rows = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    // Skip header row ("Dimension") and the "---" separator row.
    if (/^dimension$/i.test(cells[0]) || /^:?-+:?$/.test(cells[0])) continue;
    rows.push({
      dimension: cells[0],
      report: cells[1] || "",
      findings: cells[2] || "",
    });
  }
  return rows;
}

/** Extracts {critical, high, medium, low} counts from free text like
 * "2 high, 1 medium" — returns null if no severity word is recognized,
 * so the caller can fall back to a raw string comparison instead of
 * silently reporting a delta of 0. */
export function parseFindingsCounts(findingsText) {
  const text = String(findingsText || "").toLowerCase();
  const severities = ["critical", "high", "medium", "low"];
  const counts = {};
  let matched = false;

  for (const severity of severities) {
    const re = new RegExp(`(\\d+)\\s*${severity}`, "i");
    const m = text.match(re);
    counts[severity] = m ? Number(m[1]) : 0;
    if (m) matched = true;
  }

  return matched ? counts : null;
}

export function diffRounds(fromRows, toRows) {
  const fromByDim = new Map(fromRows.map((r) => [r.dimension, r]));
  const toByDim = new Map(toRows.map((r) => [r.dimension, r]));
  const dimensions = [...new Set([...fromByDim.keys(), ...toByDim.keys()])].sort();

  return dimensions.map((dimension) => {
    const from = fromByDim.get(dimension) || null;
    const to = toByDim.get(dimension) || null;

    if (!from) return { dimension, status: "new", from: null, to: to.findings };
    if (!to) return { dimension, status: "removed", from: from.findings, to: null };

    const fromCounts = parseFindingsCounts(from.findings);
    const toCounts = parseFindingsCounts(to.findings);

    if (fromCounts && toCounts) {
      const delta = {};
      let totalDelta = 0;
      for (const severity of Object.keys(toCounts)) {
        delta[severity] = toCounts[severity] - fromCounts[severity];
        totalDelta += delta[severity];
      }
      return {
        dimension,
        status: totalDelta === 0 ? "unchanged" : totalDelta > 0 ? "worse" : "better",
        from: from.findings,
        to: to.findings,
        delta,
      };
    }

    return {
      dimension,
      status: from.findings === to.findings ? "unchanged" : "changed",
      from: from.findings,
      to: to.findings,
    };
  });
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    process.exit(0);
  }

  const repoRoot = resolve(argValue("--root") || root);
  const asJson = process.argv.includes("--json");

  let fromPath = argValue("--from");
  let toPath = argValue("--to");

  if (!fromPath || !toPath) {
    const summaryDir = join(auditsRoot(repoRoot), "_summary");
    const summaries = findSummaries(summaryDir);
    if (summaries.length < 2) {
      console.error(
        `Need at least 2 audit-run summaries under ${summaryDir} to diff (found ${summaries.length}).`
      );
      console.error("Run /audit-run (or the full-audit skill) at least twice, or pass --from/--to explicitly.");
      process.exit(1);
    }
    toPath = summaries[summaries.length - 1];
    fromPath = summaries[summaries.length - 2];
  }

  const fromAbs = resolve(process.cwd(), fromPath);
  const toAbs = resolve(process.cwd(), toPath);
  for (const [label, p] of [["--from", fromAbs], ["--to", toAbs]]) {
    if (!existsSync(p)) {
      console.error(`${label} not found: ${p}`);
      process.exit(1);
    }
  }

  const fromRows = parseReportsTable(readFileSync(fromAbs, "utf8"));
  const toRows = parseReportsTable(readFileSync(toAbs, "utf8"));

  if (!fromRows.length || !toRows.length) {
    console.error("One of the summaries has no parseable ## Reports table rows — run hyperion:audit-verify first.");
    process.exit(1);
  }

  const diffs = diffRounds(fromRows, toRows);

  if (asJson) {
    console.log(JSON.stringify({ from: fromAbs, to: toAbs, diffs }, null, 2));
    return;
  }

  console.log(`[audit-diff] From: ${fromAbs}`);
  console.log(`[audit-diff]   To: ${toAbs}`);
  console.log("");

  const statusLabel = {
    new: "NEW      ",
    removed: "REMOVED  ",
    unchanged: "unchanged",
    changed: "changed  ",
    better: "better   ",
    worse: "WORSE    ",
  };

  for (const d of diffs) {
    const label = statusLabel[d.status] || d.status;
    if (d.status === "new") {
      console.log(`  ${label}  ${d.dimension}: ${d.to}`);
    } else if (d.status === "removed") {
      console.log(`  ${label}  ${d.dimension}: was ${d.from}`);
    } else if (d.delta) {
      const deltaStr = Object.entries(d.delta)
        .filter(([, v]) => v !== 0)
        .map(([sev, v]) => `${v > 0 ? "+" : ""}${v} ${sev}`)
        .join(", ");
      console.log(`  ${label}  ${d.dimension}: ${d.from} -> ${d.to}${deltaStr ? `  (${deltaStr})` : ""}`);
    } else {
      console.log(`  ${label}  ${d.dimension}: ${d.from} -> ${d.to}`);
    }
  }

  const worseCount = diffs.filter((d) => d.status === "worse" || d.status === "new").length;
  console.log("");
  console.log(worseCount ? `${worseCount} dimension(s) got worse or are new.` : "No dimension got worse.");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
