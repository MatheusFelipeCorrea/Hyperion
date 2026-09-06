import test from "node:test";
import assert from "node:assert/strict";
import { parseHistoryLines, summarizeHistory } from "./history.mjs";

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
