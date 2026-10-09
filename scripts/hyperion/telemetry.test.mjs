import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isTelemetryEnabled, recordEvent, telemetryFilePath } from "./telemetry-lib.mjs";
import { cleanupTmp, hyperionDir, makeTmp, runNode, writeFiles } from "./test-support/cli-harness.mjs";

const telemetry = join(hyperionDir, "telemetry.mjs");
const USAGE = ".github/plans/telemetry/usage.jsonl";
const OPTED_IN = { ".github/project.yml": "telemetry:\n  enabled: true\n" };

after(cleanupTmp);

describe("telemetry.mjs", () => {
  it("explains how to opt in when nothing is recorded", () => {
    const root = makeTmp("telemetry-");
    const r = runNode(telemetry, [], { cwd: root });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No usage recorded yet/);
    assert.match(r.stdout, /Not opted in/);
  });

  it("says enabled-but-empty, in text and --json (via --root)", () => {
    const root = writeFiles(makeTmp("telemetry-"), OPTED_IN);
    const text = runNode(telemetry, ["--root", root], { cwd: makeTmp() });
    assert.match(text.stdout, /Enabled — nothing recorded/);
    const json = runNode(telemetry, ["--json", "--root", root], { cwd: makeTmp() });
    assert.deepEqual(JSON.parse(json.stdout), { enabled: true, events: 0, counts: {} });
  });

  it("counts events, skipping malformed lines, sorted by frequency", () => {
    const lines = [
      { kind: "agent-gate", name: "review-verify" },
      { kind: "agent-gate", name: "phase-verify" },
      { kind: "agent-gate", name: "phase-verify" },
    ].map((e) => JSON.stringify(e));
    const root = writeFiles(makeTmp("telemetry-"), { ...OPTED_IN, [USAGE]: `${lines.join("\n")}\nnot json\n` });
    const text = runNode(telemetry, [], { cwd: root });
    assert.equal(text.status, 0);
    assert.match(text.stdout, /3 event\(s\) recorded/);
    assert.match(text.stdout, /2 {2}agent-gate:phase-verify[\s\S]*1 {2}agent-gate:review-verify/);
    const json = JSON.parse(runNode(telemetry, ["--json"], { cwd: root, env: { HYPERION_TELEMETRY: "false" } }).stdout);
    assert.deepEqual(json, { enabled: false, events: 3, counts: { "agent-gate:phase-verify": 2, "agent-gate:review-verify": 1 } });
  });

  it("reports no events when the log only has unparseable lines", () => {
    const root = writeFiles(makeTmp("telemetry-"), { [USAGE]: "{broken\n" });
    const r = runNode(telemetry, [], { cwd: root });
    assert.match(r.stdout, /0 event\(s\) recorded/);
    assert.match(r.stdout, /\(no events yet\)/);
  });

  it("does nothing when imported (not the entry script)", async () => {
    await import("./telemetry.mjs");
  });
});

describe("telemetry-lib failure handling", () => {
  it("treats an unreadable project.yml as not opted in", () => {
    const root = makeTmp("telemetry-");
    mkdirSync(join(root, ".github", "project.yml"), { recursive: true });
    const saved = process.env.HYPERION_TELEMETRY;
    delete process.env.HYPERION_TELEMETRY;
    try {
      assert.equal(isTelemetryEnabled(root), false);
    } finally {
      if (saved !== undefined) process.env.HYPERION_TELEMETRY = saved;
    }
  });

  it("recordEvent swallows write failures", () => {
    const root = writeFiles(makeTmp("telemetry-"), { ".github/plans/telemetry": "a file where the dir should be" });
    const saved = process.env.HYPERION_TELEMETRY;
    process.env.HYPERION_TELEMETRY = "true";
    try {
      assert.doesNotThrow(() => recordEvent(root, "agent-gate", "phase-verify"));
      assert.equal(existsSync(telemetryFilePath(root)), false);
    } finally {
      if (saved === undefined) delete process.env.HYPERION_TELEMETRY;
      else process.env.HYPERION_TELEMETRY = saved;
    }
  });
});
