import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isTelemetryEnabled, recordEvent, telemetryFilePath } from "./telemetry-lib.mjs";

const createdDirs = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-telemetry-"));
  createdDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.HYPERION_TELEMETRY;
});

test("isTelemetryEnabled is false with no project.yml and no env override", () => {
  const dir = makeRepo();
  delete process.env.HYPERION_TELEMETRY;
  assert.equal(isTelemetryEnabled(dir), false);
});

test("isTelemetryEnabled reads telemetry.enabled: true from project.yml", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "project.yml"),
    "locale: en\ntelemetry:\n  enabled: true\nother_key: x\n"
  );
  delete process.env.HYPERION_TELEMETRY;
  assert.equal(isTelemetryEnabled(dir), true);
});

test("isTelemetryEnabled ignores an unrelated block also named enabled elsewhere", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "project.yml"),
    "locale: en\ntelemetry:\n  enabled: false\nmanagement:\n  enabled: true\n"
  );
  delete process.env.HYPERION_TELEMETRY;
  assert.equal(isTelemetryEnabled(dir), false);
});

test("HYPERION_TELEMETRY env var overrides project.yml in both directions", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github", "project.yml"), "telemetry:\n  enabled: true\n");

  process.env.HYPERION_TELEMETRY = "false";
  assert.equal(isTelemetryEnabled(dir), false);

  process.env.HYPERION_TELEMETRY = "true";
  writeFileSync(join(dir, ".github", "project.yml"), "telemetry:\n  enabled: false\n");
  assert.equal(isTelemetryEnabled(dir), true);

  delete process.env.HYPERION_TELEMETRY;
});

test("recordEvent is a silent no-op when telemetry isn't opted in", () => {
  const dir = makeRepo();
  delete process.env.HYPERION_TELEMETRY;
  recordEvent(dir, "agent-gate", "phase-verify");
  assert.equal(existsSync(telemetryFilePath(dir)), false);
});

test("recordEvent appends a JSONL line, local-only, when opted in", () => {
  const dir = makeRepo();
  process.env.HYPERION_TELEMETRY = "true";
  recordEvent(dir, "agent-gate", "phase-verify");
  recordEvent(dir, "agent-gate", "review-verify", { ok: true });

  const filePath = telemetryFilePath(dir);
  assert.ok(existsSync(filePath));
  const lines = readFileSync(filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]);
  assert.equal(first.kind, "agent-gate");
  assert.equal(first.name, "phase-verify");
  assert.ok(first.ts);

  const second = JSON.parse(lines[1]);
  assert.equal(second.name, "review-verify");
  assert.equal(second.ok, true);

  delete process.env.HYPERION_TELEMETRY;
});

test("every agent gate records its event under --root, not in the kit checkout", () => {
  const dir = makeRepo();
  const file = (name, content) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };
  const gates = [
    ["phase-verify", ["--plan", file("plan-phase.md", "## Verification\n- phase: 1\n- tests_result: PASS\n")]],
    [
      "plan-verify",
      ["--plan", file("plan.md", "---\ngoal: g\ncard_id: C-1\nstatus: Planned\n---\n\n### Phase 1: x\n\n## Verification\n- run tests\n")],
    ],
    [
      "review-verify",
      ["--review", file("pr-1-review.md", "---\nverdict: APPROVE\ntests_ran: yes\n---\n\n## Summary\nok\n\n## Findings\nNone.\n")],
    ],
    [
      "spec-review-verify",
      [
        "--review",
        file(
          "C-1-review.md",
          "---\ncard_id: C-1\nverdict: APPROVED\n---\n\n## Summary\nok\n\n## Checklist\n| a | b |\n|---|---|\n| x | y |\n\n## Blocking issues\nNone.\n\n## Recommended next step\n- /implement\n"
        ),
      ],
    ],
    [
      "audit-verify",
      [
        "--summary",
        file(
          "audit.md",
          "## Executive Summary\nok\n\n## Reports\n| Dimension | Report |\n|---|---|\n| Security | r.md |\n\n## Cross-cutting Themes\n- x\n\n## Recommended Priority Fixes\n1. y\n"
        ),
      ],
    ],
    ["release-verify", []],
  ];
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0] - 2026-01-01\n### Added\n- Thing.\n");

  const env = { ...process.env, HYPERION_TELEMETRY: "true" };
  for (const [gate, args] of gates) {
    const script = fileURLToPath(new URL(`./${gate}.mjs`, import.meta.url));
    const r = spawnSync(process.execPath, [script, ...args, "--root", dir], { encoding: "utf8", env });
    assert.equal(r.status, 0, `${gate}: ${r.stdout}${r.stderr}`);
  }
  const names = readFileSync(telemetryFilePath(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l).name);
  assert.deepEqual(names, gates.map(([gate]) => gate));
});
