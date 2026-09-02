import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "spec-review-verify.mjs");

describe("spec-review-verify", () => {
  it("passes with required sections and APPROVED verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-ok-"));
    try {
      const file = join(dir, "PROJ-STORY-001-review.md");
      writeFileSync(
        file,
        `---
card_id: PROJ-STORY-001
review_date: 2026-08-21
verdict: APPROVED
reviewer: spec-review agent
---

# Spec review — PROJ-STORY-001

## Summary
Looks ready.

## Checklist
| Item | Status | Notes |
|------|--------|-------|
| Goal | Pass | Clear |

## Blocking issues
None.

## Warnings (non-blocking)
None.

## Recommended next step
- APPROVED → /implement
`
      );
      const r = spawnSync(process.execPath, [script, "--review", file], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /spec-review-verify OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when verdict is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-bad-"));
    try {
      const file = join(dir, "PROJ-STORY-002-review.md");
      writeFileSync(
        file,
        `---
card_id: PROJ-STORY-002
---
## Summary
x
## Checklist
y
## Blocking issues
z
## Recommended next step
w
`
      );
      const r = spawnSync(process.execPath, [script, "--review", file], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when BLOCKED verdict lists a real blocking issue", () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-blocked-ok-"));
    try {
      const file = join(dir, "PROJ-STORY-004-review.md");
      writeFileSync(
        file,
        `---
card_id: PROJ-STORY-004
verdict: BLOCKED
---
## Summary
Not ready.
## Checklist
| Item | Status |
|------|--------|
| Goal | Fail |
## Blocking issues
- No acceptance criteria defined.
- Missing auth requirements.
## Recommended next step
- BLOCKED -> /spec
`
      );
      const r = spawnSync(process.execPath, [script, "--review", file], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when BLOCKED verdict has no listed blocking issue", () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-blocked-"));
    try {
      const file = join(dir, "PROJ-STORY-003-review.md");
      writeFileSync(
        file,
        `---
card_id: PROJ-STORY-003
verdict: BLOCKED
---
## Summary
x
## Checklist
y
## Blocking issues
None.
## Recommended next step
w
`
      );
      const r = spawnSync(process.execPath, [script, "--review", file], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /BLOCKED but ## Blocking issues has no listed issue/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
