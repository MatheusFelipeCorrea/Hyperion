#!/usr/bin/env node
/**
 * Reads back sync-history.jsonl (written by appendSyncEvent — forward sync
 * runs and PR board-guard checks) and prints a summary: counts by event
 * type, failure rate, and the most recent events.
 *
 * Distinct from `cards:metrics`, which mines git log for status: frontmatter
 * transitions (cycle time / WIP) — this reads the sync *operation* log
 * itself (did a sync run, did it succeed, how many cards/actions).
 *
 * Run: npm run cards:history
 *      npm run cards:history -- --json
 *      npm run cards:history -- --limit 5   # show 5 most recent raw events
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

export function parseHistoryLines(raw) {
  const entries = [];
  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip a corrupt/partial line (e.g. a crash mid-write) rather than
      // failing the whole read — this is an append-only log, not a database.
    }
  }
  return entries;
}

export function summarizeHistory(entries) {
  const byType = {};
  let okCount = 0;
  let failCount = 0;

  for (const entry of entries) {
    const type = entry.type || "unknown";
    byType[type] = (byType[type] || 0) + 1;
    if (entry.ok) okCount += 1;
    else failCount += 1;
  }

  return {
    total: entries.length,
    okCount,
    failCount,
    byType,
    firstAt: entries[0]?.ts || null,
    lastAt: entries[entries.length - 1]?.ts || null,
  };
}

async function readHistory(historyPath) {
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    return parseHistoryLines(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function formatDetails(entry) {
  const { ts, type, repository, ok, ...details } = entry;
  const parts = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`);
  return parts.join(" ");
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 10 : null;

  const paths = resolveHyperionPaths(process.cwd());
  const historyPath = path.join(paths.plansCardsDir, "sync-history.jsonl");

  const entries = await readHistory(historyPath);

  if (entries === null) {
    if (asJson) {
      console.log(JSON.stringify({ total: 0, byType: {}, note: "no sync-history.jsonl yet" }, null, 2));
      return;
    }
    console.log("[cards-history] No sync-history.jsonl yet — run `npm run cards:sync` (or let the board guard run in CI) first.");
    return;
  }

  if (limit) {
    const recent = entries.slice(-limit);
    if (asJson) {
      console.log(JSON.stringify(recent, null, 2));
      return;
    }
    console.log(`[cards-history] Last ${recent.length} event(s):`);
    for (const entry of recent) {
      const status = entry.ok ? "OK  " : "FAIL";
      console.log(`  ${entry.ts}  ${status}  ${entry.type}  ${formatDetails(entry)}`);
    }
    return;
  }

  const summary = summarizeHistory(entries);

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`[cards-history] ${summary.total} event(s) — ${summary.okCount} ok, ${summary.failCount} failed`);
  console.log(`  First: ${summary.firstAt}`);
  console.log(`  Last:  ${summary.lastAt}`);
  console.log("");
  console.log("By type:");
  for (const [type, count] of Object.entries(summary.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${type}`);
  }
  console.log("");
  console.log("Use --limit N to see the N most recent raw events.");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[cards-history] FATAL: ${err.message}`);
    process.exit(1);
  });
}
