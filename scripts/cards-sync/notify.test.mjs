import test from "node:test";
import assert from "node:assert/strict";
import { buildSlackPayload, buildDiscordPayload, formatSyncMessage } from "./notify.mjs";

test("buildSlackPayload wraps text in {text}", () => {
  assert.deepEqual(buildSlackPayload("hello"), { text: "hello" });
});

test("buildDiscordPayload wraps text in {content}", () => {
  assert.deepEqual(buildDiscordPayload("hello"), { content: "hello" });
});

test("formatSyncMessage marks a successful entry with a check and includes details", () => {
  const msg = formatSyncMessage({
    ts: "2026-01-01T00:00:00.000Z",
    type: "forward-sync",
    repository: "acme/widgets",
    ok: true,
    cardCount: 12,
    actionCount: 3,
  });
  assert.match(msg, /^✅/);
  assert.match(msg, /forward-sync/);
  assert.match(msg, /acme\/widgets/);
  assert.match(msg, /cardCount=12/);
  assert.match(msg, /actionCount=3/);
});

test("formatSyncMessage marks a failed entry with a cross", () => {
  const msg = formatSyncMessage({
    ts: "2026-01-01T00:00:00.000Z",
    type: "pr-guard-fail",
    repository: "acme/widgets",
    ok: false,
    reason: "external-drift",
  });
  assert.match(msg, /^❌/);
  assert.match(msg, /pr-guard-fail/);
  assert.match(msg, /reason=external-drift/);
});

test("formatSyncMessage handles a null entry (no history yet) without throwing", () => {
  const msg = formatSyncMessage(null);
  assert.match(msg, /no history entry/);
});
