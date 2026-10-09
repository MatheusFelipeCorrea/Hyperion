import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  addUnmeasured,
  countLines,
  coverageFailureAnnotation,
  formatReport,
  isSourceFile,
  normalizeSourcePath,
  parseLcov,
  summarize,
} from "./coverage.mjs";
import { errorAnnotation, escapeData, escapeProperty } from "./annotations.mjs";

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

test("on Windows a drive letter in another case is the same file, counted once", () => {
  const lcov = "SF:C:\\Work\\scripts\\Hyperion\\scripts\\kit\\x.mjs\nLF:10\nLH:5\nend_of_record\nSF:c:\\work\\scripts\\Hyperion\\scripts\\kit\\x.mjs\nLF:10\nLH:7\nend_of_record\n";
  const files = parseLcov(lcov, "c:\\Work\\scripts\\Hyperion", "win32");
  assert.deepEqual(files, [{ file: "scripts/kit/x.mjs", lf: 10, lh: 7 }]);
  assert.equal(normalizeSourcePath("C:\\Work\\scripts\\Hyperion\\scripts\\kit\\x.mjs", "c:\\Work\\scripts\\Hyperion", "win32"), "scripts/kit/x.mjs");

  const merged = addUnmeasured(files, ["scripts/kit/x.mjs"], () => 99);
  assert.deepEqual(summarize(merged, 95).lf, 10, "measured file must not also be added as unmeasured");

  assert.equal(normalizeSourcePath("/Repo/scripts/kit/x.mjs", "/repo", "linux"), "scripts/kit/x.mjs", "POSIX falls back to the scripts/ segment");
  assert.equal(normalizeSourcePath("/Repo/a/scripts/kit/x.mjs", "/repo/a", "linux"), "scripts/kit/x.mjs");
});

test("countLines ignores the newline that ends the file", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\r\nb\r\n"), 2);
  assert.equal(countLines("a\n\n"), 2, "a real blank last line still counts");
});

test("annotations escape workflow-command properties and data", () => {
  assert.equal(escapeProperty("Kit coverage below 95%: a,b\r\n"), "Kit coverage below 95%25%3A a%2Cb%0D%0A");
  assert.equal(escapeData("50%: a,b\nc"), "50%25: a,b%0Ac");
  const line = coverageFailureAnnotation({ pct: 52.5, needed: 10 }, 95);
  assert.match(line, /^::error title=Kit coverage below 95%25::52\.50%25 of the kit's lines/);
  assert.equal(errorAnnotation("t", "m"), "::error title=t::m");
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
