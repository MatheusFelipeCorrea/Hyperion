import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  diffCoverageFromGit,
  evaluateDiffCoverage,
  lineHitsFromCobertura,
  lineHitsFromGoCover,
  lineHitsFromIstanbulFinal,
  lineHitsFromLcov,
  lineHitsFromReport,
  matchCoverageFile,
  parseAddedLines,
  renderDiffSummary,
} from "./diff-coverage.mjs";

const DIFF = [
  "diff --git a/src/a.js b/src/a.js",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,0 +2,3 @@",
  "+const x = 1;",
  "+const y = 2;",
  "+// comment",
  "@@ -10 +13 @@",
  "-old",
  "+new",
  "diff --git a/gone.js b/gone.js",
  "--- a/gone.js",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
].join("\n");

describe("parseAddedLines", () => {
  it("collects new-side line numbers per file and drops deletions", () => {
    const added = parseAddedLines(DIFF);
    assert.deepEqual([...added.keys()], ["src/a.js"]);
    assert.deepEqual([...added.get("src/a.js")], [2, 3, 4, 13]);
  });
});

describe("line hit parsers", () => {
  it("reads lcov DA records", () => {
    const hits = lineHitsFromLcov("TN:\nSF:/repo/src/a.js\nDA:2,1\nDA:3,0\nend_of_record\n");
    assert.deepEqual([...hits.get("/repo/src/a.js")], [[2, 1], [3, 0]]);
  });

  it("reads Cobertura lines and prefixes <source> roots", () => {
    const xml = '<coverage><sources><source>/w/app</source></sources><packages><package><classes><class filename="m.py"><methods/><lines><line number="1" hits="2"/><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>';
    const hits = lineHitsFromCobertura(xml);
    assert.equal(hits.get("m.py").get(1), 2);
    assert.equal(hits.get("/w/app/m.py").get(2), 0);
  });

  it("reads Go cover profiles and Istanbul coverage-final", () => {
    const go = lineHitsFromGoCover("mode: set\nexample.com/svc/x.go:3.2,5.10 2 1\n");
    assert.deepEqual([...go.get("example.com/svc/x.go").keys()], [3, 4, 5]);
    const ist = lineHitsFromIstanbulFinal(JSON.stringify({ "/r/a.js": { path: "/r/a.js", statementMap: { 0: { start: { line: 4 }, end: { line: 4 } } }, s: { 0: 0 } } }));
    assert.equal(ist.get("/r/a.js").get(4), 0);
  });

  it("picks the parser from content", () => {
    assert.ok(lineHitsFromReport("lcov.info", "SF:a\nDA:1,1\nend_of_record").has("a"));
    assert.ok(lineHitsFromReport("cover.out", "mode: atomic\na.go:1.1,1.5 1 0\n").has("a.go"));
    assert.throws(() => lineHitsFromReport("x.txt", "nothing"), /No line-level data/);
  });
});

describe("evaluateDiffCoverage", () => {
  it("matches paths by suffix and counts only coverable changed lines", () => {
    assert.equal(matchCoverageFile("src/a.js", ["/repo/src/a.js", "/repo/other/src/a.js.map"]), "/repo/src/a.js");
    const added = parseAddedLines(DIFF);
    const hits = lineHitsFromLcov("SF:/repo/src/a.js\nDA:2,1\nDA:3,0\nDA:13,4\nend_of_record\n");
    const r = evaluateDiffCoverage({ added, hits, min: 80 });
    assert.equal(r.total, 3);
    assert.equal(r.covered, 2);
    assert.equal(Math.round(r.pct), 67);
    assert.equal(r.ok, false);
    assert.deepEqual(r.files[0].missed, [3]);
    assert.match(renderDiffSummary(r, { mode: "warn" }), /⚠️/);
  });

  it("passes with no coverable lines and honours ignore globs", () => {
    const added = parseAddedLines(DIFF);
    const hits = lineHitsFromLcov("SF:src/a.js\nDA:3,0\nend_of_record\n");
    const r = evaluateDiffCoverage({ added, hits, min: 90, ignore: ["src/**"] });
    assert.equal(r.pct, null);
    assert.equal(r.ok, true);
    assert.match(renderDiffSummary(r), /No coverable changed lines/);
  });
});

describe("diffCoverageFromGit", () => {
  it("diffs against a base commit and reads the lcov report", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-diffcov-"));
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
    try {
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src/a.js"), "one\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(dir, "src/a.js"), "one\ntwo\nthree\n");
      git("commit", "-qam", "change");
      fs.mkdirSync(path.join(dir, "coverage"));
      fs.writeFileSync(path.join(dir, "coverage/lcov.info"), `SF:${path.join(dir, "src/a.js")}\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n`);
      const r = diffCoverageFromGit({ dir, base, min: 50 });
      assert.equal(r.total, 2);
      assert.equal(r.covered, 1);
      assert.equal(r.ok, true);
      assert.match(r.report, /lcov\.info$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
