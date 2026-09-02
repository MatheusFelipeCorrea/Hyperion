import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
});
