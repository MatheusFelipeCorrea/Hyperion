import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
      const r = spawnSync(process.execPath, [script, "--plan", plan], { encoding: "utf8" });
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
      const r = spawnSync(process.execPath, [script, "--plan", plan], { encoding: "utf8" });
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
      const r = spawnSync(process.execPath, [script, "--plan", plan], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /frontmatter.status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
