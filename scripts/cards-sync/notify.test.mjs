import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildSlackPayload, buildDiscordPayload, formatSyncMessage } from "./notify.mjs";
import { runWithFetchMock } from "../hyperion/fetch-mock.mjs";
import { cleanEnv, cleanupTempDirs, makeTempDir, scriptPath, writeFile } from "./test-support/ci-fixture.mjs";

const notifyScript = scriptPath("notify.mjs");
const SLACK = "https://hooks.slack.test/services/x";
const DISCORD = "https://discord.test/api/webhooks/x";
let route;

before(() => {
  route = writeFile(
    makeTempDir("hyperion-notify-route-"),
    "route.mjs",
    `export default (req) => {
  const fail = (process.env.NOTIFY_FAIL || "").split(",");
  const target = req.url.includes("slack") ? "slack" : req.url.includes("discord") ? "discord" : null;
  if (!target || req.method !== "POST") return undefined;
  if (fail.includes(target)) return new Response(target + " down", { status: 500 });
  return new Response(null, { status: 204 });
};
`
  );
});

after(cleanupTempDirs);

function notify(args, env = {}, ws = makeTempDir("hyperion-notify-ws-")) {
  const isolated = { ...Object.fromEntries(Object.keys(process.env).map((k) => [k, undefined])), ...cleanEnv(env) };
  return runWithFetchMock(notifyScript, args, { cwd: ws, route, env: isolated });
}

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

test("formatSyncMessage tolerates missing type/repository and empty details", () => {
  assert.equal(formatSyncMessage({ ok: true, note: "", ids: ["a", "b"] }), "✅ Hyperion cards sync — unknown (ids=a,b)");
});

test("CLI: no webhook configured is a silent opt-out", () => {
  const r = notify(["--message", "hi"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No SLACK_WEBHOOK_URL \/ DISCORD_WEBHOOK_URL configured — skipping/);
  assert.equal(r.calls.length, 0);
});

test("CLI: --message posts to both Slack and Discord", () => {
  const r = notify(["--message", "Deploy done"], { SLACK_WEBHOOK_URL: SLACK, DISCORD_WEBHOOK_URL: DISCORD });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Posted to Slack\./);
  assert.match(r.stdout, /Posted to Discord\./);
  const byUrl = Object.fromEntries(r.calls.map((c) => [c.url, c]));
  assert.deepEqual(byUrl[SLACK].body, { text: "Deploy done" });
  assert.deepEqual(byUrl[DISCORD].body, { content: "Deploy done" });
  assert.equal(byUrl[SLACK].headers["Content-Type"], "application/json");
});

test("CLI: without --message the latest sync-history entry is sent (or a placeholder)", () => {
  const ws = makeTempDir("hyperion-notify-hist-");
  const empty = notify([], { SLACK_WEBHOOK_URL: SLACK }, ws);
  assert.match(empty.calls[0].body.text, /no history entry available/);

  writeFile(
    ws,
    ".github/plans/cards/sync-history.jsonl",
    `${JSON.stringify({ ts: "1", type: "pr-guard", ok: true })}\n${JSON.stringify({ ts: "2", type: "forward-sync", repository: "acme/app", ok: true, cardCount: 2 })}\n`
  );
  const r = notify([], { SLACK_WEBHOOK_URL: SLACK }, ws);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[0].body.text, "✅ Hyperion cards sync — forward-sync acme/app (cardCount=2)");
});

test("CLI: one failing webhook warns but succeeds; all failing sets exit code 1", () => {
  const partial = notify(["--message", "x"], { SLACK_WEBHOOK_URL: SLACK, DISCORD_WEBHOOK_URL: DISCORD, NOTIFY_FAIL: "slack" });
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(partial.stderr, /WARN: Webhook POST failed \(500\): slack down/);
  assert.match(partial.stdout, /Posted to Discord\./);

  const all = notify(["--message", "x"], { DISCORD_WEBHOOK_URL: DISCORD, NOTIFY_FAIL: "discord" });
  assert.equal(all.status, 1);
  assert.match(all.stderr, /WARN: Webhook POST failed \(500\): discord down/);
});

test("CLI: an unreadable history file is fatal", () => {
  const ws = makeTempDir("hyperion-notify-bad-");
  mkdirSync(join(ws, ".github/plans/cards/sync-history.jsonl"), { recursive: true });
  const r = notify([], { SLACK_WEBHOOK_URL: SLACK }, ws);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[notify\] FATAL: /);
});
