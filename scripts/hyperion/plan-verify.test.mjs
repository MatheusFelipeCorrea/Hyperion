import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "plan-verify.mjs");

describe("plan-verify", () => {
  it("passes with frontmatter, a phase section, and Verification", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-ok-"));
    try {
      const plan = join(dir, "feature-x-1.md");
      writeFileSync(
        plan,
        `---
goal: Add feature X
card_id: PROJ-123
version: 1.0
date_created: 2026-08-21
status: 'Planned'
---

# Introduction

## 1. Requirements & Constraints
- REQ-001: ...

## 2. Implementation Steps

### Phase 1: Domain model
- GOAL-001: ...

| Task | Description | File Action | Completed | Date |
|------|-------------|-------------|-----------|------|
| TASK-001 | ... | [CREATE] path | | |

## 7. Verification

| Step | Type | Action | Expected Result | Maps to |
|------|------|--------|-----------------|---------|
| VER-001 | TEST | Run project tests | All pass | — |
`
      );
      const r = spawnSync(process.execPath, [script, "--plan", plan, "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /plan-verify OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when there is no Phase section", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-nophase-"));
    try {
      const plan = join(dir, "feature-y-1.md");
      writeFileSync(
        plan,
        `---
goal: Add feature Y
card_id: PROJ-124
status: 'Planned'
---

## 7. Verification
Nothing planned yet.
`
      );
      const r = spawnSync(process.execPath, [script, "--plan", plan, "--root", dir], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no "### Phase N" section/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with an invalid status", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-badstatus-"));
    try {
      const plan = join(dir, "feature-z-1.md");
      writeFileSync(
        plan,
        `---
goal: Add feature Z
card_id: PROJ-125
status: 'Whatever'
---

### Phase 1: Something

## Verification
table here
`
      );
      const r = spawnSync(process.execPath, [script, "--plan", plan, "--root", dir], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /frontmatter.status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plan-verify CLI branches", () => {
  const env = { ...process.env, HYPERION_TELEMETRY: "false" };
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  let dir;
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    return join(dir, rel);
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pv-cli-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:[\s\S]*--latest \[--root <repo-root>\]/);
  });

  it("--latest --root picks the last plan by name", () => {
    write("repo/.github/plans/implementations/a.md", "garbage\n");
    write(
      "repo/.github/plans/implementations/b.md",
      "---\ngoal: G\ncard_id: C-1\nstatus: In progress\n---\n### Phase 1: x\n## Verification\n"
    );
    write("repo/.github/plans/implementations/.c.md", "garbage\n");
    const r = run(["--latest", "--root", join(dir, "repo")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK frontmatter\.status: In progress/);
    assert.match(r.stdout, /plan-verify OK/);
  });

  it("fails with usage when no plan can be found", () => {
    write("empty/.github/plans/implementations/.gitkeep", "");
    for (const root of [join(dir, "empty"), join(dir, "nothing")]) {
      const r = run(["--root", root]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /No plan specified and none found/);
      assert.match(r.stdout, /Usage:/);
    }
  });

  it("fails when the plan file does not exist", () => {
    const r = run(["--plan", join(dir, "missing.md")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Plan not found: /);
  });

  it("reports a missing frontmatter block and a missing Verification section", () => {
    const r = run(["--plan", write("nofm.md", "# Plan\n### Phase 1\n")]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL: no frontmatter block found/);
    assert.match(r.stderr, /FAIL: missing Verification section/);
    assert.match(r.stderr, /plan-verify FAILED \(2\)/);
  });

  it("reports missing goal/card_id/status frontmatter fields", () => {
    const r = run(["--plan", write("partial.md", "---\nversion: 1\n---\n### Phase 1\n## Verification\n")]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL frontmatter: missing "goal:"/);
    assert.match(r.stderr, /FAIL frontmatter: missing "card_id:"/);
    assert.match(r.stderr, /FAIL frontmatter\.status: got "\(missing\)"/);
  });
});
