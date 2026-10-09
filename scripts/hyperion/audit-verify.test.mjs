import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
      const r = spawnSync(process.execPath, [script, "--summary", file, "--root", dir], { encoding: "utf8" });
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
      const r = spawnSync(process.execPath, [script, "--summary", file, "--root", dir], { encoding: "utf8" });
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
      const r = spawnSync(process.execPath, [script, "--summary", file, "--root", dir], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no table row or link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const GOOD_SUMMARY = `## Executive Summary
ok

## Reports
- [Security](../application-security/report.md)

## Cross-cutting Themes
none

## Recommended Priority Fixes
none
`;

describe("audit-verify CLI branches", () => {
  const env = { ...process.env, HYPERION_TELEMETRY: "false" };
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  let dir;
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    return join(dir, rel);
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "av-cli-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--help prints usage and exits 0", () => {
    const r = run(["-h"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:[\s\S]*## Recommended Priority Fixes/);
  });

  it("--latest uses .github/audits/results by default (no project.yml, no audits key, null/empty value)", () => {
    write("default/.github/audits/results/_summary/audit-run-2026-01-01.md", "# old, invalid\n");
    write("default/.github/audits/results/_summary/audit-run-2026-02-01.md", GOOD_SUMMARY);
    write("default/.github/audits/results/_summary/.draft.md", "# hidden\n");
    write("default/.github/audits/results/_summary/notes.txt", "x");
    for (const yml of [null, "version: 1\nname: x\n", "outputs:\n  audits: null\n", "outputs:\n  audits: '~'\n", 'outputs:\n  audits: ""\n']) {
      if (yml === null) rmSync(join(dir, "default/.github/project.yml"), { force: true });
      else write("default/.github/project.yml", yml);
      const r = run(["--latest", "--root", join(dir, "default")]);
      assert.equal(r.status, 0, `${yml}\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /OK ## Reports lists dimension report\(s\)/);
    }
  });

  it("--latest honours outputs.audits from project.yml", () => {
    write("custom/.github/project.yml", 'outputs:\n  audits: "./docs/audits"\n');
    write("custom/docs/audits/_summary/audit-run-2026-03-01.md", GOOD_SUMMARY);
    const r = run(["--root", join(dir, "custom")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /audit-verify OK/);
  });

  it("fails with usage when no summary can be found", () => {
    write("empty/.github/audits/results/_summary/.gitkeep", "");
    for (const root of [join(dir, "empty"), join(dir, "nothing")]) {
      const r = run(["--latest", "--root", root]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /No summary specified and none found under .*_summary/);
      assert.match(r.stdout, /Usage:/);
    }
  });

  it("fails when the summary file does not exist", () => {
    const r = run(["--summary", join(dir, "missing.md")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Summary not found: /);
  });
});
