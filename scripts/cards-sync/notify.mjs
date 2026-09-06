#!/usr/bin/env node
/**
 * Optional Slack/Discord notification for a sync result. No-ops silently
 * if neither webhook env var is set — this is opt-in, not everyone wants
 * a bot posting every sync run.
 *
 * Env:
 *   SLACK_WEBHOOK_URL    — Slack incoming webhook URL
 *   DISCORD_WEBHOOK_URL  — Discord channel webhook URL
 * (either, both, or neither — neither means notify silently does nothing)
 *
 * Usage:
 *   node scripts/cards-sync/notify.mjs --message "Custom text"
 *   node scripts/cards-sync/notify.mjs                # reads the most
 *                                                       # recent sync-history.jsonl entry
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";
import { parseHistoryLines } from "./history.mjs";

export function buildSlackPayload(text) {
  return { text };
}

export function buildDiscordPayload(text) {
  return { content: text };
}

/** Turns one appendSyncEvent-shaped entry into a human-readable line. */
export function formatSyncMessage(entry) {
  if (!entry) return "Hyperion cards sync — no history entry available.";

  const icon = entry.ok ? "✅" : "❌";
  const repo = entry.repository ? ` ${entry.repository}` : "";
  const { ts, type, repository, ok, ...details } = entry;
  const detailParts = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`);
  const detailStr = detailParts.length ? ` (${detailParts.join(", ")})` : "";

  return `${icon} Hyperion cards sync — ${type || "unknown"}${repo}${detailStr}`;
}

async function postWebhook(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Webhook POST failed (${response.status}): ${text}`);
  }
}

async function readMostRecentEntry(historyPath) {
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    const entries = parseHistoryLines(raw);
    return entries[entries.length - 1] || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function log(msg) {
  console.log(`[notify] ${msg}`);
}

async function main() {
  const slackUrl = process.env.SLACK_WEBHOOK_URL || null;
  const discordUrl = process.env.DISCORD_WEBHOOK_URL || null;

  if (!slackUrl && !discordUrl) {
    log("No SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL configured — skipping (this is opt-in).");
    return;
  }

  const messageIdx = process.argv.indexOf("--message");
  let text = messageIdx >= 0 ? process.argv[messageIdx + 1] : null;

  if (!text) {
    const paths = resolveHyperionPaths(process.cwd());
    const historyPath = path.join(paths.plansCardsDir, "sync-history.jsonl");
    const entry = await readMostRecentEntry(historyPath);
    text = formatSyncMessage(entry);
  }

  const posts = [];
  if (slackUrl) posts.push(postWebhook(slackUrl, buildSlackPayload(text)).then(() => log("Posted to Slack.")));
  if (discordUrl) posts.push(postWebhook(discordUrl, buildDiscordPayload(text)).then(() => log("Posted to Discord.")));

  const results = await Promise.allSettled(posts);
  const failures = results.filter((r) => r.status === "rejected");
  for (const failure of failures) {
    console.error(`[notify] WARN: ${failure.reason?.message || failure.reason}`);
  }
  if (failures.length === results.length && results.length > 0) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[notify] FATAL: ${err.message}`);
    process.exit(1);
  });
}
