import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { addUnmeasured, formatReport, isSourceFile, normalizeSourcePath, parseLcov, summarize } from "./coverage.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "coverage.mjs");

const LCOV = [
  "SF:C:\\repo\\scripts\\hyperion\\a.mjs",
  "LF:100",
  "LH:90",
  "end_of_record",
  "SF:/repo/scripts/cards-sync/b.mjs",
  "LF:50",
  "LH:50",
  "end_of_record",
  "SF:/repo/scripts/hyperion/a.test.mjs",
  "LF:10",
  "LH:10",
  "end_of_record",
].join("\n");

test("parseLcov normalizes Windows and POSIX paths relative to the root", () => {
  const files = parseLcov(LCOV, "C:\\repo");
  assert.deepEqual(files.map((f) => f.file), ["scripts/hyperion/a.mjs", "scripts/cards-sync/b.mjs", "scripts/hyperion/a.test.mjs"]);
  assert.equal(files[0].lh, 90);
  assert.equal(normalizeSourcePath("/repo/scripts/kit/x.mjs", "/repo"), "scripts/kit/x.mjs");
});

test("isSourceFile skips tests and the live e2e scripts", () => {
  assert.equal(isSourceFile("scripts/hyperion/a.mjs"), true);
  assert.equal(isSourceFile("scripts/hyperion/a.test.mjs"), false);
  assert.equal(isSourceFile("scripts/cards-sync/e2e/e2e-forward-sync.mjs"), false);
});

test("addUnmeasured counts never-imported files as fully uncovered", () => {
  const files = addUnmeasured(parseLcov(LCOV, "/repo"), ["scripts/hyperion/a.mjs", "scripts/cards-sync/b.mjs", "scripts/hyperion/c.mjs"], () => 50);
  const c = files.find((f) => f.file === "scripts/hyperion/c.mjs");
  assert.deepEqual({ lf: c.lf, lh: c.lh, unmeasured: c.unmeasured }, { lf: 50, lh: 0, unmeasured: true });
  assert.ok(!files.some((f) => f.file.endsWith(".test.mjs")), "test files never count");

  const s = summarize(files, 95);
  assert.equal(s.lf, 200);
  assert.equal(s.lh, 140);
  assert.equal(s.ok, false);
  assert.equal(s.needed, 50);
  assert.deepEqual(s.gaps.map((g) => g.file), ["scripts/hyperion/c.mjs", "scripts/hyperion/a.mjs"]);
  assert.match(formatReport(s, 95), /no test imports it/);
});

test("summarize passes at the threshold", () => {
  const s = summarize([{ file: "scripts/kit/x.mjs", lf: 100, lh: 95 }], 95);
  assert.equal(s.ok, true);
  assert.equal(s.needed, 0);
  assert.deepEqual(s.gaps, []);
});

test("CLI with --lcov fails below --min with an actionable message, passes above", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-cov-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const lcovPath = join(dir, "lcov.info");
    writeFileSync(lcovPath, "SF:scripts/kit/x.mjs\nLF:10\nLH:8\nend_of_record\n");
    const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };

    const low = spawnSync(process.execPath, [scriptPath, "--root", dir, "--lcov", lcovPath, "--min", "95"], { encoding: "utf8", env });
    assert.equal(low.status, 1);
    assert.match(low.stderr, /cover 2 more lines/);
    assert.match(low.stderr, /npm run kit:coverage/);

    const ok = spawnSync(process.execPath, [scriptPath, "--root", dir, "--lcov", lcovPath, "--min", "80"], { encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /kit:coverage OK/);

    const missing = spawnSync(process.execPath, [scriptPath, "--root", dir, "--lcov", join(dir, "nope.info")], { encoding: "utf8", env });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /lcov file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
