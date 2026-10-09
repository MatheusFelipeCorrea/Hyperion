import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "release-verify.mjs");

describe("release-verify", () => {
  it("passes when CHANGELOG has a non-empty section for package.json's version", () => {
    const dir = mkdtempSync(join(tmpdir(), "rlv-ok-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.2.0" }));
      writeFileSync(
        join(dir, "CHANGELOG.md"),
        `# Changelog

## [Unreleased]

## [1.2.0] - 2026-08-21
### Added
- New thing.
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /release-verify OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when CHANGELOG has no section for the current version", () => {
    const dir = mkdtempSync(join(tmpdir(), "rlv-missing-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.3.0" }));
      writeFileSync(
        join(dir, "CHANGELOG.md"),
        `# Changelog

## [1.2.0] - 2026-08-21
### Added
- Old thing.
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no "## \[1\.3\.0\]" section/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when the version heading is on its own line (content on following lines)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rlv-multiline-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "3.0.0" }));
      writeFileSync(
        join(dir, "CHANGELOG.md"),
        `# Changelog

## [3.0.0]
### Added
- New thing.
### Fixed
- A bug.

## [2.0.0]
### Added
- Old thing.
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the version section is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "rlv-empty-"));
    try {
      writeFileSync(
        join(dir, "CHANGELOG.md"),
        `# Changelog

## [2.0.0]

## [1.0.0]
### Added
- Something.
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir, "--version", "2.0.0"], {
        encoding: "utf8",
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /section in CHANGELOG.md is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the version section is empty, even with a date suffix on the heading", () => {
    // Regression: the capture used to start right after "]", so a
    // Keep-a-Changelog date suffix ("## [2.0.0] — 2026-09-01") was itself
    // read as section "content" and an empty release silently passed.
    const dir = mkdtempSync(join(tmpdir(), "rlv-empty-dated-"));
    try {
      writeFileSync(
        join(dir, "CHANGELOG.md"),
        `# Changelog

## [2.0.0] — 2026-09-01

## [1.0.0]
### Added
- Something.
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir, "--version", "2.0.0"], {
        encoding: "utf8",
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /section in CHANGELOG.md is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("release-verify CLI branches", () => {
  const env = { ...process.env, HYPERION_TELEMETRY: "false" };
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "rlv-cli-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:[\s\S]*--changelog <path>/);
  });

  it("fails when CHANGELOG.md is missing", () => {
    const r = run(["--root", join(dir, "nowhere")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAIL: CHANGELOG not found at /);
  });

  it("fails with usage when no version is given and package.json is missing, invalid or versionless", () => {
    const root = join(dir, "noversion");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "CHANGELOG.md"), "## [1.0.0]\n- x\n");
    for (const pkg of [null, "{ not json", JSON.stringify({ name: "x" })]) {
      if (pkg === null) rmSync(join(root, "package.json"), { force: true });
      else writeFileSync(join(root, "package.json"), pkg);
      const r = run(["--root", root]);
      assert.equal(r.status, 1, `${pkg}\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /FAIL: no --version given and no version found in package\.json/);
      assert.match(r.stdout, /Usage:/);
    }
  });

  it("--changelog points at an explicit file; warns when [Unreleased] still has entries", () => {
    const file = join(dir, "notes", "HISTORY.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "# Changelog\n\n## [Unreleased]\n### Added\n- pending thing\n\n## [2.1.0] — 2026-10-01\n### Fixed\n- bug\n");
    const r = run(["--changelog", file, "--version", "2.1.0"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /WARN: \[Unreleased\] section still has entries/);
    assert.match(r.stdout, /OK: version section has content/);
  });

  it("does not warn for an [Unreleased] section with no bullet entries", () => {
    const file = join(dir, "notes", "CLEAN.md");
    writeFileSync(file, "## [Unreleased]\n### Added\n\n## [2.2.0]\n- shipped\n");
    const r = run(["--changelog", file, "--version", "2.2.0"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /WARN/);
  });
});
