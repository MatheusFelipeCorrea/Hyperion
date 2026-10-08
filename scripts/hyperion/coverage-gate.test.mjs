import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseReport,
  evaluateCoverage,
  makeIgnore,
  renderSummary,
} from "./coverage-gate.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "coverage-gate.mjs");

const LCOV = [
  "TN:",
  "SF:lib/main.dart",
  "DA:1,1",
  "DA:2,1",
  "DA:3,0",
  "LF:3",
  "LH:2",
  "end_of_record",
  "SF:lib/screens/home.dart",
  "DA:1,0",
  "DA:2,0",
  "LF:2",
  "LH:0",
  "end_of_record",
  "SF:lib/model.g.dart",
  "DA:1,0",
  "end_of_record",
  "",
].join("\n");

describe("parsers", () => {
  it("lcov: counts lines per file and honors ignore globs", () => {
    const all = parseReport("lcov.info", LCOV);
    assert.deepEqual(all.totals.lines, { total: 6, covered: 2 });
    const filtered = parseReport("lcov.info", LCOV, ["lib/screens/**", "*.g.dart"]);
    assert.deepEqual(filtered.totals.lines, { total: 3, covered: 2 });
    assert.equal(filtered.files, 1);
  });

  it("istanbul json-summary: uses total, recomputes when files are ignored", () => {
    const json = JSON.stringify({
      total: { lines: { total: 10, covered: 8, pct: 80 }, branches: { total: 4, covered: 2, pct: 50 } },
      "/repo/src/a.js": { lines: { total: 6, covered: 6 }, branches: { total: 2, covered: 2 } },
      "/repo/src/generated/b.js": { lines: { total: 4, covered: 2 }, branches: { total: 2, covered: 0 } },
    });
    assert.deepEqual(parseReport("coverage-summary.json", json).totals.lines, { total: 10, covered: 8 });
    assert.deepEqual(parseReport("coverage-summary.json", json, ["generated/**"]).totals.lines, { total: 6, covered: 6 });
  });

  it("cobertura: lines, branches from condition-coverage, methods", () => {
    const xml = `<?xml version="1.0"?><coverage line-rate="0.5"><packages><package><classes>
      <class name="a" filename="app/a.py"><methods><method name="f" line-rate="1"/><method name="g" line-rate="0"/></methods>
        <lines><line number="1" hits="1"/><line number="2" hits="0" branch="true" condition-coverage="50% (1/2)"/></lines></class>
      <class name="t" filename="tests/t.py"><lines><line number="1" hits="0"/></lines></class>
    </classes></package></packages></coverage>`;
    const r = parseReport("coverage.xml", xml, ["tests/**"]);
    assert.equal(r.format, "cobertura");
    assert.deepEqual(r.totals.lines, { total: 2, covered: 1 });
    assert.deepEqual(r.totals.branches, { total: 2, covered: 1 });
    assert.deepEqual(r.totals.functions, { total: 2, covered: 1 });
  });

  it("jacoco: per-sourcefile counters with ignore", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE report><report name="x">
      <package name="com/acme"><sourcefile name="A.java"><counter type="LINE" missed="2" covered="8"/><counter type="BRANCH" missed="1" covered="1"/></sourcefile>
      <sourcefile name="Gen.java"><counter type="LINE" missed="10" covered="0"/></sourcefile></package>
      <counter type="LINE" missed="12" covered="8"/></report>`;
    assert.deepEqual(parseReport("jacoco.xml", xml).totals.lines, { total: 20, covered: 8 });
    assert.deepEqual(parseReport("jacoco.xml", xml, ["Gen.java"]).totals.lines, { total: 10, covered: 8 });
  });

  it("go coverprofile: statements, dedupes repeated blocks", () => {
    const out = [
      "mode: set",
      "example.com/x/a.go:1.1,3.2 2 1",
      "example.com/x/a.go:4.1,6.2 3 0",
      "example.com/x/a.go:4.1,6.2 3 1",
      "example.com/x/b.go:1.1,2.2 5 0",
    ].join("\n");
    const r = parseReport("coverage.out", out);
    assert.deepEqual(r.totals.statements, { total: 10, covered: 5 });
  });

  it("simplecov .last_run.json", () => {
    const r = parseReport("coverage/.last_run.json", JSON.stringify({ result: { line: 91.2 } }));
    assert.equal(r.totals.lines.pct, 91.2);
  });

  it("ignore matcher: substrings and globs", () => {
    const ig = makeIgnore(["generated", "**/*.g.dart", "lib/screens/*"]);
    assert.ok(ig("src/generated/x.ts"));
    assert.ok(ig("lib/a/b.g.dart"));
    assert.ok(ig("lib/screens/home.dart"));
    assert.ok(!ig("lib/screens/sub/home.dart"));
    assert.ok(!ig("lib/main.dart"));
  });
});

describe("evaluateCoverage + CLI", () => {
  function tmpWith(rel, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-cov-"));
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
    return dir;
  }

  it("auto-discovers the report and compares against min", () => {
    const dir = tmpWith("coverage/lcov.info", LCOV);
    const pass = evaluateCoverage({ dir, metric: "lines", min: 60, ignore: ["lib/screens/**", "*.g.dart"] });
    assert.equal(pass.status, "pass");
    const fail = evaluateCoverage({ dir, metric: "lines", min: 60 });
    assert.equal(fail.status, "fail");
    assert.match(renderSummary(fail, { label: "mobile" }), /Coverage — mobile/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to an available metric with a note", () => {
    const dir = tmpWith("coverage.out", "mode: set\na.go:1.1,2.2 1 1\n");
    const r = evaluateCoverage({ dir, metric: "branches", min: 50 });
    assert.equal(r.metric, "lines");
    assert.match(r.note, /not available/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("CLI exits 1 in block mode and 0 in warn mode", () => {
    const dir = tmpWith("coverage/lcov.info", LCOV);
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--dir", dir, "--min", "90"], { stdio: "pipe", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } }));
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir, "--min", "90", "--mode", "warn"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    assert.match(out, /::warning title=Coverage gate::lines/);
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-cov-empty-"));
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--dir", missing, "--min", "1"], { stdio: "pipe", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } }));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(missing, { recursive: true, force: true });
  });
});
