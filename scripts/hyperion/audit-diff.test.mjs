import test from "node:test";
import assert from "node:assert/strict";
import { parseReportsTable, parseFindingsCounts, diffRounds } from "./audit-diff.mjs";

const SUMMARY_ROUND_1 = `# Audit Run Summary — 2026-08-01

## Executive Summary
Round 1.

## Reports
| Dimension | Report | Findings |
|-----------|--------|----------|
| Security  | results/application-security/report.md | 2 high, 1 medium |
| DevOps    | results/devops/report.md | 1 low |

## Cross-cutting Themes
- x

## Recommended Priority Fixes
1. y
`;

const SUMMARY_ROUND_2 = `# Audit Run Summary — 2026-08-21

## Executive Summary
Round 2.

## Reports
| Dimension | Report | Findings |
|-----------|--------|----------|
| Security  | results/application-security/report.md | 1 high, 1 medium |
| DevOps    | results/devops/report.md | 1 low |
| Architecture | results/architecture/report.md | 3 medium |

## Cross-cutting Themes
- x

## Recommended Priority Fixes
1. y
`;

test("parseReportsTable reads dimension/report/findings, skips header and separator rows", () => {
  const rows = parseReportsTable(SUMMARY_ROUND_1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    dimension: "Security",
    report: "results/application-security/report.md",
    findings: "2 high, 1 medium",
  });
  assert.equal(rows[1].dimension, "DevOps");
});

test("parseReportsTable returns an empty array when there's no ## Reports section", () => {
  assert.deepEqual(parseReportsTable("# no reports section here"), []);
});

test("parseFindingsCounts extracts severity counts from free text", () => {
  assert.deepEqual(parseFindingsCounts("2 high, 1 medium"), { critical: 0, high: 2, medium: 1, low: 0 });
});

test("parseFindingsCounts returns null when no severity word is recognized", () => {
  assert.equal(parseFindingsCounts("see report for details"), null);
});

test("diffRounds reports improvement, a new dimension, and an unchanged one", () => {
  const from = parseReportsTable(SUMMARY_ROUND_1);
  const to = parseReportsTable(SUMMARY_ROUND_2);
  const diffs = diffRounds(from, to);

  const security = diffs.find((d) => d.dimension === "Security");
  assert.equal(security.status, "better");
  assert.equal(security.delta.high, -1);

  const devops = diffs.find((d) => d.dimension === "DevOps");
  assert.equal(devops.status, "unchanged");

  const architecture = diffs.find((d) => d.dimension === "Architecture");
  assert.equal(architecture.status, "new");
  assert.equal(architecture.from, null);
});

test("diffRounds marks a dimension present in `from` but absent in `to` as removed", () => {
  const from = [{ dimension: "UX", report: "r.md", findings: "1 low" }];
  const to = [];
  const diffs = diffRounds(from, to);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].status, "removed");
  assert.equal(diffs[0].to, null);
});

test("diffRounds falls back to raw string comparison when findings text has no severity counts", () => {
  const from = [{ dimension: "PO", report: "r.md", findings: "see notes" }];
  const to = [{ dimension: "PO", report: "r.md", findings: "no major gaps" }];
  const diffs = diffRounds(from, to);
  assert.equal(diffs[0].status, "changed");
});
