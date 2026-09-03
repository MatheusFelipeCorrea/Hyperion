#!/usr/bin/env node
/**
 * Flow metrics mined from git history of cards — cycle time per status
 * and current WIP per column. No board API calls, no network: everything
 * comes from `git log` + the `status:` frontmatter you already commit.
 * watch.mjs already reacts to status changes live; this shows the
 * aggregate picture over time.
 *
 * Run: npm run cards:metrics
 *      npm run cards:metrics -- --json
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";
import { listCardsMarkdownFiles } from "./lib.mjs";

const MS_PER_DAY = 86_400_000;

export function extractStatus(content) {
  const m = String(content || "").match(/^status:\s*(.+)$/m);
  if (!m) return null;
  const raw = m[1].trim().replace(/^["']|["']$/g, "");
  return raw === "null" || raw === "" ? null : raw;
}

export function extractCardId(content) {
  const m = String(content || "").match(/^card_id:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

/**
 * Turn a chronological list of {date, status} snapshots into segments the
 * card actually spent in each status: {status, days, ongoing}. `now`
 * closes out the segment the card is currently in.
 */
export function statusSegments(history, now = new Date()) {
  const segments = [];
  for (let i = 0; i < history.length; i++) {
    const current = history[i];
    const next = history[i + 1];
    const start = new Date(current.date);
    const end = next ? new Date(next.date) : now;
    const days = (end.getTime() - start.getTime()) / MS_PER_DAY;
    segments.push({ status: current.status, days: Math.max(days, 0), ongoing: !next });
  }
  return segments;
}

function git(workspaceRoot, args) {
  return execFileSync("git", args, { cwd: workspaceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** Chronological (oldest-first) list of distinct status values a card held, mined from git log. */
export function statusHistoryForFile(workspaceRoot, relPath) {
  let log;
  try {
    log = git(workspaceRoot, ["log", "--follow", "--format=%H|%aI", "--", relPath]).trim();
  } catch {
    return [];
  }
  if (!log) return [];

  const commits = log
    .split("\n")
    .map((line) => {
      const [hash, date] = line.split("|");
      return { hash, date };
    })
    .reverse(); // oldest first

  const history = [];
  let lastStatus;
  for (const { hash, date } of commits) {
    let content;
    try {
      content = git(workspaceRoot, ["show", `${hash}:${relPath}`]);
    } catch {
      continue; // renamed/deleted at that point in history — skip
    }
    const status = extractStatus(content);
    if (status !== lastStatus) {
      history.push({ date, status });
      lastStatus = status;
    }
  }
  return history;
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function collectMetrics(workspaceRoot, cardsRoot) {
  const files = await listCardsMarkdownFiles(cardsRoot, { forSync: true });
  const currentWip = {};
  const durationsByStatus = {};

  for (const file of files) {
    const relPath = path.relative(workspaceRoot, file).replace(/\\/g, "/");
    const history = statusHistoryForFile(workspaceRoot, relPath);
    if (!history.length) continue;

    const currentStatus = history[history.length - 1].status;
    if (currentStatus) currentWip[currentStatus] = (currentWip[currentStatus] || 0) + 1;

    for (const segment of statusSegments(history)) {
      if (!segment.status || segment.ongoing) continue; // only closed segments count toward cycle time
      (durationsByStatus[segment.status] ||= []).push(segment.days);
    }
  }

  const cycleTimeByStatus = Object.fromEntries(
    Object.entries(durationsByStatus).map(([status, days]) => [
      status,
      { avgDays: Math.round(average(days) * 10) / 10, samples: days.length },
    ])
  );

  return { currentWip, cycleTimeByStatus, cardCount: files.length };
}

async function main() {
  const asJson = process.argv.includes("--json");
  const paths = resolveHyperionPaths(process.cwd());
  const metrics = await collectMetrics(paths.workspaceRoot, paths.cardsRoot);

  if (asJson) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  console.log(`[cards-metrics] ${metrics.cardCount} card(s) with git history`);
  console.log("");
  console.log("WIP now, by status:");
  const wipEntries = Object.entries(metrics.currentWip).sort((a, b) => b[1] - a[1]);
  if (!wipEntries.length) console.log("  (no cards with a status set)");
  for (const [status, count] of wipEntries) console.log(`  ${String(count).padStart(3)}  ${status}`);

  console.log("");
  console.log("Average time spent per status (closed segments only, i.e. not counting the current one):");
  const cycleEntries = Object.entries(metrics.cycleTimeByStatus).sort((a, b) => b[1].avgDays - a[1].avgDays);
  if (!cycleEntries.length) console.log("  (not enough history yet — no card has changed status more than once)");
  for (const [status, { avgDays, samples }] of cycleEntries) {
    console.log(`  ${String(avgDays).padStart(6)}d avg  ${status}  (${samples} sample${samples === 1 ? "" : "s"})`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[cards-metrics] FATAL: ${err.message}`);
    process.exit(1);
  });
}
