import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "phase-verify.mjs");

describe("phase-verify", () => {
  it("passes when Verification has tests_result PASS", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-verify-"));
    try {
      const plan = join(dir, "plan.md");
      writeFileSync(
        plan,
        `# Plan\n\n## Phase 1\n- [x] done\n\n## Verification\n- phase: 1\n- tests_command: npm test\n- tests_result: PASS\n- tested_at: 2026-08-21T12:00:00Z\n`
      );
      const r = spawnSync(process.execPath, [script, "--plan", plan, "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /phase-verify OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when tests_result is FAIL", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-verify-"));
    try {
      const plan = join(dir, "plan.md");
      writeFileSync(
        plan,
        `## Verification\n- phase: 2\n- tests_command: npm test\n- tests_result: FAIL\n- tested_at: 2026-08-21T12:00:00Z\n`
      );
      const r = spawnSync(process.execPath, [script, "--plan", plan, "--phase", "2"], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("phase-verify CLI branches", () => {
  const env = { ...process.env, HYPERION_TELEMETRY: "false" };
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  let dir;
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    return join(dir, rel);
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "phase-verify-cli-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:[\s\S]*--latest \[--root <repo-root>\]/);
    assert.equal(run(["-h"]).status, 0);
  });

  it("--latest --root picks the last plan by name under .github/plans/implementations", () => {
    write("repo/.github/plans/implementations/a-plan.md", "## Verification\n- phase: 1\n- tests_result: FAIL\n");
    write("repo/.github/plans/implementations/b-plan.md", "## Verification\n- phase: 1\n- tests_result: PASS\n");
    write("repo/.github/plans/implementations/.c-hidden.md", "x");
    write("repo/.github/plans/implementations/z-notes.txt", "x");
    const r = run(["--latest", "--root", join(dir, "repo")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK phase 1: PASS \(tests_command n\/a\) @ \?/);
  });

  it("fails with usage when no plan is given and none can be found", () => {
    mkdirSync(join(dir, "empty/.github/plans/implementations"), { recursive: true });
    writeFileSync(join(dir, "empty/.github/plans/implementations/.gitkeep"), "");
    for (const root of [join(dir, "empty"), join(dir, "no-plans-dir")]) {
      const r = run(["--root", root]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /No plan specified and none found/);
      assert.match(r.stdout, /Usage:/);
    }
  });

  it("fails when the plan file does not exist", () => {
    const r = run(["--plan", join(dir, "nope.md")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Plan not found: /);
  });

  it("fails when --phase has no matching Verification block", () => {
    const plan = write("p-phase.md", "## Verification\n- phase: 1\n- tests_result: PASS\n");
    const r = run(["--plan", plan, "--phase", "3"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No Verification block for phase 3/);
  });

  it("explains the expected block when the plan has no Verification at all", () => {
    const plan = write("p-none.md", "# Plan\n\n## Phase 1\n- [ ] todo\n");
    const r = run(["--plan", plan]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No ## Verification blocks found[\s\S]*- tests_result: PASS\|FAIL/);
  });

  it("infers completed phases (checkboxes, done marker, inline PASS) and requires a PASS block for each", () => {
    const plan = write(
      "p-infer.md",
      [
        "# Plan",
        "## Phase 1",
        "- [x] a",
        "- [X] b",
        "## Phase 2",
        "Done ✅",
        "## Phase 3",
        "- tests_result: PASS",
        "## Phase 4",
        "- [x] a",
        "- [ ] b",
        "## Phase 5",
        "not started",
        "## Verification",
        "- phase: 1",
        "- tests_command: npm test",
        "- tests_result: PASS",
        "- tested_at: 2026-10-01T00:00:00Z",
        "",
      ].join("\n")
    );
    const r = run(["--plan", plan]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /OK phase 1: PASS \(npm test\) @ 2026-10-01T00:00:00Z/);
    assert.match(r.stderr, /FAIL phase 2: tests_result is "\(missing\)"/);
    assert.match(r.stderr, /FAIL phase 3: tests_result is "\(missing\)"/);
    assert.doesNotMatch(r.stderr, /phase [45]/);
    assert.match(r.stderr, /phase-verify FAILED \(2\)/);
  });

  it("checks Verification blocks as-is when no phase looks complete (unknown phase label)", () => {
    const plan = write("p-unknown.md", "## Phase 1\n- [ ] todo\n\n## Verification\n- tests_result: pass\n");
    const r = run(["--plan", plan]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK unknown phase: PASS/);
    assert.match(r.stdout, /phase-verify OK \(1 phase\(s\)\)/);
  });
});
