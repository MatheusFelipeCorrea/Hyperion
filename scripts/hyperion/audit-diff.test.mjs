import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseReportsTable, parseFindingsCounts, diffRounds, findSummaries } from "./audit-diff.mjs";

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

describe("audit-diff CLI", () => {
  const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "audit-diff.mjs");
  const summary = (rows) =>
    `# Audit Run Summary\n\n## Reports\n| Dimension | Report | Findings |\n|---|---|---|\n${rows
      .map(([dim, findings]) => `| ${dim} | results/${dim}/report.md | ${findings} |`)
      .join("\n")}\n\n## Cross-cutting Themes\n- x\n`;
  const ROUND_A = summary([["Security", "2 high"], ["DevOps", "1 low"], ["UX", "see notes"], ["Old", "1 low"], ["Same", "1 medium"]]);
  const ROUND_B = summary([["Security", "1 high"], ["DevOps", "3 low"], ["UX", "updated notes"], ["New", "2 medium"], ["Same", "1 medium"]]);

  function withRepo(files, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-audit-diff-"));
    try {
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
      }
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() };
  delete env.HYPERION_ROOT;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: os.tmpdir(), env, encoding: "utf8" });

  it("--help prints usage", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
  });

  it("diffs the two most recent summaries in the default results folder (human output)", () => {
    const files = {
      ".github/audits/results/_summary/audit-run-2026-01-01.md": ROUND_A,
      ".github/audits/results/_summary/audit-run-2026-02-01.md": ROUND_B,
      ".github/audits/results/_summary/.draft.md": "ignored",
      ".github/audits/results/_summary/notes.txt": "ignored",
      ".github/project.yml": "version: 1\n",
    };
    withRepo(files, (dir) => {
      assert.deepEqual(
        findSummaries(path.join(dir, ".github/audits/results/_summary")).map((f) => path.basename(f)),
        ["audit-run-2026-01-01.md", "audit-run-2026-02-01.md"]
      );
      const r = run(["--root", dir]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /From: .*audit-run-2026-01-01\.md/);
      assert.match(r.stdout, /To: .*audit-run-2026-02-01\.md/);
      assert.match(r.stdout, /better {5}Security: 2 high -> 1 high {2}\(-1 high\)/);
      assert.match(r.stdout, /WORSE {6}DevOps: 1 low -> 3 low {2}\(\+2 low\)/);
      assert.match(r.stdout, /changed {4}UX: see notes -> updated notes/);
      assert.match(r.stdout, /NEW {8}New: 2 medium/);
      assert.match(r.stdout, /REMOVED {4}Old: was 1 low/);
      assert.match(r.stdout, /unchanged {2}Same: 1 medium -> 1 medium\r?\n/);
      assert.match(r.stdout, /2 dimension\(s\) got worse or are new\./);
    });
  });

  it("honors outputs.audits from project.yml and emits JSON", () => {
    const files = {
      ".github/project.yml": 'outputs:\n  audits: "./custom/audits"\n',
      "custom/audits/_summary/a.md": ROUND_A,
      "custom/audits/_summary/b.md": ROUND_A,
    };
    withRepo(files, (dir) => {
      const r = run(["--root", dir, "--json"]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.match(out.from, /a\.md$/);
      assert.ok(out.diffs.every((d) => d.status === "unchanged"));
    });
  });

  it("falls back to the default folder for an empty audits value and needs two summaries", () => {
    for (const yml of ["outputs:\n  audits: ~\n", null]) {
      const files = { ".github/audits/results/_summary/only.md": ROUND_A };
      if (yml) files[".github/project.yml"] = yml;
      withRepo(files, (dir) => {
        const r = run(["--root", dir]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /Need at least 2 audit-run summaries .*\(found 1\)/);
      });
    }
  });

  it("--from/--to: reports a missing file, a summary without a table, and an all-clear diff", () => {
    withRepo({ "a.md": ROUND_A, "b.md": ROUND_A, "empty.md": "# nothing\n" }, (dir) => {
      const missing = run(["--from", path.join(dir, "nope.md"), "--to", path.join(dir, "b.md")]);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /--from not found/);
      const noTable = run(["--from", path.join(dir, "a.md"), "--to", path.join(dir, "empty.md")]);
      assert.equal(noTable.status, 1);
      assert.match(noTable.stderr, /no parseable ## Reports table/);
      const clean = run(["--from", path.join(dir, "a.md"), "--to", path.join(dir, "b.md")]);
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(clean.stdout, /No dimension got worse\./);
    });
  });
});
