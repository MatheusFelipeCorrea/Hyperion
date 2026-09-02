import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "audit-verify.mjs");

describe("audit-verify", () => {
  it("passes with all required sections", () => {
    const dir = mkdtempSync(join(tmpdir(), "av-ok-"));
    try {
      const file = join(dir, "audit-run-2026-08-21.md");
      writeFileSync(
        file,
        `# Audit Run Summary — 2026-08-21

## Executive Summary
Overall healthy, a few security findings.

## Reports
| Dimension | Report | Severity |
|-----------|--------|----------|
| Security | results/application-security/report.md | 2 high |

## Cross-cutting Themes
- Missing test coverage in payments module.

## Recommended Priority Fixes
1. Patch dependency X.
`
      );
      const r = spawnSync(process.execPath, [script, "--summary", file], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /audit-verify OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when Cross-cutting Themes is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "av-bad-"));
    try {
      const file = join(dir, "audit-run-2026-08-22.md");
      writeFileSync(
        file,
        `# Audit Run Summary

## Executive Summary
x

## Reports
| Dimension | Report |
|-----------|--------|
| Security | report.md |

## Recommended Priority Fixes
- fix it
`
      );
      const r = spawnSync(process.execPath, [script, "--summary", file], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Cross-cutting Themes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when Reports section has no table row or link", () => {
    const dir = mkdtempSync(join(tmpdir(), "av-noreports-"));
    try {
      const file = join(dir, "audit-run-2026-08-23.md");
      writeFileSync(
        file,
        `## Executive Summary
x

## Reports
Nothing here yet.

## Cross-cutting Themes
y

## Recommended Priority Fixes
z
`
      );
      const r = spawnSync(process.execPath, [script, "--summary", file], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no table row or link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
