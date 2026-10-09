import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseHistoryLines, summarizeHistory } from "./history.mjs";
import { cleanupTempDirs, makeTempDir, runNode, scriptPath, writeFile } from "./test-support/ci-fixture.mjs";

const historyScript = scriptPath("history.mjs");
const HISTORY = ".github/plans/cards/sync-history.jsonl";

after(cleanupTempDirs);

test("parseHistoryLines parses one JSON object per line, skipping blanks", () => {
  const raw = [
    JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "forward-sync", ok: true }),
    "",
    JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", type: "pr-guard", ok: false }),
    "",
  ].join("\n");

  const entries = parseHistoryLines(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, "forward-sync");
  assert.equal(entries[1].ok, false);
});

test("parseHistoryLines skips a corrupt line instead of throwing", () => {
  const raw = [
    JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "forward-sync", ok: true }),
    "{not valid json",
    JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", type: "pr-guard", ok: true }),
  ].join("\n");

  const entries = parseHistoryLines(raw);
  assert.equal(entries.length, 2);
});

test("summarizeHistory counts by type and ok/fail, tracks first/last timestamp", () => {
  const entries = [
    { ts: "2026-01-01T00:00:00.000Z", type: "forward-sync", ok: true },
    { ts: "2026-01-02T00:00:00.000Z", type: "forward-sync", ok: true },
    { ts: "2026-01-03T00:00:00.000Z", type: "pr-guard-fail", ok: false },
  ];

  const summary = summarizeHistory(entries);
  assert.equal(summary.total, 3);
  assert.equal(summary.okCount, 2);
  assert.equal(summary.failCount, 1);
  assert.deepEqual(summary.byType, { "forward-sync": 2, "pr-guard-fail": 1 });
  assert.equal(summary.firstAt, "2026-01-01T00:00:00.000Z");
  assert.equal(summary.lastAt, "2026-01-03T00:00:00.000Z");
});

test("summarizeHistory handles an empty list without throwing", () => {
  const summary = summarizeHistory([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.firstAt, null);
  assert.equal(summary.lastAt, null);
});

test("an entry missing `type` is counted as unknown, not dropped", () => {
  const summary = summarizeHistory([{ ts: "2026-01-01T00:00:00.000Z", ok: true }]);
  assert.deepEqual(summary.byType, { unknown: 1 });
});

function workspaceWithHistory() {
  const ws = makeTempDir("hyperion-history-cli-");
  writeFile(
    ws,
    HISTORY,
    [
      { ts: "2026-01-01T00:00:00.000Z", type: "forward-sync", repository: "acme/app", ok: true, cardCount: 2, incrementalIds: ["A", "B"], project: null },
      { ts: "2026-01-02T00:00:00.000Z", type: "pr-guard-fail", ok: false, reason: "external-drift" },
      { ts: "2026-01-03T00:00:00.000Z", type: "forward-sync", ok: true },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
  return ws;
}

test("CLI: no history file yet (text and --json)", () => {
  const ws = makeTempDir("hyperion-history-cli-empty-");
  const text = runNode(historyScript, [], { cwd: ws });
  assert.equal(text.status, 0, text.output);
  assert.match(text.stdout, /No sync-history\.jsonl yet/);
  const json = runNode(historyScript, ["--json"], { cwd: ws });
  assert.deepEqual(JSON.parse(json.stdout), { total: 0, byType: {}, note: "no sync-history.jsonl yet" });
});

test("CLI: summary by type (text and --json)", () => {
  const ws = workspaceWithHistory();
  const text = runNode(historyScript, [], { cwd: ws });
  assert.equal(text.status, 0, text.output);
  assert.match(text.stdout, /3 event\(s\) — 2 ok, 1 failed/);
  assert.match(text.stdout, /First: 2026-01-01T00:00:00\.000Z\n {2}Last: {2}2026-01-03T00:00:00\.000Z/);
  assert.match(text.stdout, /By type:\n {4}2 {2}forward-sync\n {4}1 {2}pr-guard-fail/);
  const json = JSON.parse(runNode(historyScript, ["--json"], { cwd: ws }).stdout);
  assert.equal(json.total, 3);
  assert.deepEqual(json.byType, { "forward-sync": 2, "pr-guard-fail": 1 });
});

test("CLI: --limit shows the most recent raw events (text and --json)", () => {
  const ws = workspaceWithHistory();
  const text = runNode(historyScript, ["--limit", "2"], { cwd: ws });
  assert.equal(text.status, 0, text.output);
  assert.match(text.stdout, /Last 2 event\(s\):/);
  assert.match(text.stdout, /2026-01-02T00:00:00\.000Z {2}FAIL {2}pr-guard-fail {2}reason=external-drift/);
  assert.match(text.stdout, /2026-01-03T00:00:00\.000Z {2}OK {4}forward-sync {2}\n/);
  assert.doesNotMatch(text.stdout, /2026-01-01/);

  const all = runNode(historyScript, ["--limit", "nope"], { cwd: ws });
  assert.match(all.stdout, /Last 3 event\(s\):/, "non-numeric --limit falls back to 10");
  assert.match(all.stdout, /cardCount=2 incrementalIds=A,B\n/);

  const json = JSON.parse(runNode(historyScript, ["--json", "--limit", "1"], { cwd: ws }).stdout);
  assert.deepEqual(json.map((e) => e.ts), ["2026-01-03T00:00:00.000Z"]);
});

test("CLI: an unreadable history file is fatal", () => {
  const ws = makeTempDir("hyperion-history-cli-bad-");
  mkdirSync(join(ws, HISTORY), { recursive: true });
  const r = runNode(historyScript, [], { cwd: ws });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[cards-history\] FATAL: /);
});
