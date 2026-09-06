import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
