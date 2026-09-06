#!/usr/bin/env node
/**
 * Summarize local usage telemetry — see telemetry-lib.mjs for what's
 * recorded (the 6 agent gates: phase/review/audit/plan/spec-review/
 * release-verify) and why skill/agent invocation itself isn't (they're
 * markdown the chat assistant reads, not code this repo executes).
 *
 * Run: npm run hyperion:telemetry
 *      npm run hyperion:telemetry -- --json
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isTelemetryEnabled, telemetryFilePath } from "./telemetry-lib.mjs";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function main() {
  const root = resolve(argValue("--root") || process.cwd());
  const asJson = process.argv.includes("--json");
  const filePath = telemetryFilePath(root);

  if (!existsSync(filePath)) {
    if (asJson) {
      console.log(JSON.stringify({ enabled: isTelemetryEnabled(root), events: 0, counts: {} }, null, 2));
      return;
    }
    console.log("[telemetry] No usage recorded yet.");
    console.log(
      isTelemetryEnabled(root)
        ? "[telemetry] Enabled — nothing recorded because no gate (*-verify) has run yet."
        : '[telemetry] Not opted in. Add to .github/project.yml:\n\n  telemetry:\n    enabled: true\n'
    );
    return;
  }

  const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  const events = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const counts = {};
  for (const e of events) {
    const key = `${e.kind}:${e.name}`;
    counts[key] = (counts[key] || 0) + 1;
  }

  if (asJson) {
    console.log(JSON.stringify({ enabled: isTelemetryEnabled(root), events: events.length, counts }, null, 2));
    return;
  }

  console.log(`[telemetry] ${events.length} event(s) recorded — 100% local, never leaves this machine (${filePath})`);
  console.log("");
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    console.log("  (no events yet)");
  }
  for (const [key, count] of sorted) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
