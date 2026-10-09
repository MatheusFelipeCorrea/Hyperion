import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

const SECTIONS = "## Summary\nx\n## Checklist\ny\n## Blocking issues\nNone\n## Recommended next step\nw\n";

describe("spec-review-verify CLI branches", () => {
  const env = { ...process.env, HYPERION_TELEMETRY: "false" };
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  let dir;
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    return join(dir, rel);
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "srv-cli-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--help prints usage and exits 0", () => {
    const r = run(["-h"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:[\s\S]*pr-\*-review\.md/);
  });

  it("--latest --root skips pr-reviewer artifacts and non-review files; body-only fields are accepted", () => {
    write("repo/.github/plans/reviews/PROJ-1-review.md", "garbage\n");
    write("repo/.github/plans/reviews/PROJ-2-review.md", `card_id: PROJ-2\nverdict: approved with warnings\n\n${SECTIONS}`);
    write("repo/.github/plans/reviews/pr-9-review.md", "garbage\n");
    write("repo/.github/plans/reviews/zz-notes.md", "garbage\n");
    write("repo/.github/plans/reviews/.x-review.md", "garbage\n");
    const r = run(["--latest", "--root", join(dir, "repo")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK card_id: PROJ-2/);
    assert.match(r.stdout, /OK verdict: approved with warnings/);
  });

  it("fails with usage when no spec review can be found", () => {
    write("only-pr/.github/plans/reviews/pr-3-review.md", "x");
    for (const root of [join(dir, "only-pr"), join(dir, "nothing")]) {
      const r = run(["--root", root]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /No review specified and none found .*\(spec-review naming\)/);
      assert.match(r.stdout, /Usage:/);
    }
  });

  it("fails when the review file does not exist", () => {
    const r = run(["--review", join(dir, "missing.md")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Review not found: /);
  });

  it("reports missing card_id, missing headings and an empty BLOCKED section", () => {
    const file = write("bad.md", "---\nverdict: BLOCKED\n---\n## Summary\nx\n## Blocking issues\n- ...\n");
    const r = run(["--review", file]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL card_id: missing/);
    assert.match(r.stderr, /FAIL: missing ## Checklist/);
    assert.match(r.stderr, /FAIL: missing ## Recommended next step/);
    assert.match(r.stderr, /BLOCKED but ## Blocking issues has no listed issue/);
    assert.match(r.stderr, /spec-review-verify FAILED \(4\)/);

    const noSection = run(["--review", write("blocked-nosection.md", "card_id: X\nverdict: blocked\n## Summary\n")]);
    assert.match(noSection.stderr, /FAIL: missing ## Blocking issues/);
    assert.match(noSection.stderr, /BLOCKED but ## Blocking issues has no listed issue/);
  });
});
