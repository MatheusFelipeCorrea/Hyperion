/**
 * Local, opt-in usage telemetry for the agent gates that are actually
 * code-executed (phase/review/audit/plan/spec-review/release-verify).
 *
 * Scope, on purpose: skills and agents themselves are markdown read by the
 * chat assistant, not code this repo runs — there's no reliable hook point
 * to observe "skill X was used" from inside a script. The 6 *-verify gates
 * are the one place agent usage is already real code execution, so that's
 * what this measures. Off by default; opt in via `.github/project.yml`:
 *
 *   telemetry:
 *     enabled: true
 *
 * Everything stays local — appended to a gitignored JSONL file, no network
 * call, ever. See scripts/hyperion/telemetry.mjs for the summary reader.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export function telemetryFilePath(root) {
  return join(root, ".github", "plans", "telemetry", "usage.jsonl");
}

function readProjectYmlTelemetryFlag(root) {
  const p = join(root, ".github", "project.yml");
  if (!existsSync(p)) return false;
  try {
    const raw = readFileSync(p, "utf8");
    // Line-by-line scan, same convention as readKitRootFromProjectYml in
    // paths.mjs — deliberately not a single regex spanning the block: a
    // lazy [\s\S]*? bounded by `$` breaks under the /m flag (`$` matches
    // end-of-line there, not end-of-string), a bug this codebase already
    // hit more than once in similar block-scoped-key parsers.
    const lines = raw.split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      if (/^\s*telemetry\s*:\s*$/.test(line)) {
        inBlock = true;
        continue;
      }
      if (inBlock) {
        if (/^\S/.test(line)) break; // next top-level key — block ended
        if (/^\s+enabled\s*:\s*true\s*$/.test(line)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function isTelemetryEnabled(root) {
  if (String(process.env.HYPERION_TELEMETRY || "").toLowerCase() === "true") return true;
  if (String(process.env.HYPERION_TELEMETRY || "").toLowerCase() === "false") return false;
  return readProjectYmlTelemetryFlag(root);
}

/**
 * Record one usage event. Silently does nothing when telemetry isn't
 * opted in, and silently swallows any write failure — an instrumentation
 * point must never be the reason a gate script fails.
 */
export function recordEvent(root, kind, name, extra = {}) {
  if (!isTelemetryEnabled(root)) return;
  try {
    const filePath = telemetryFilePath(root);
    mkdirSync(join(filePath, ".."), { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), kind, name, ...extra })}\n`;
    appendFileSync(filePath, line, "utf8");
  } catch {
    // best-effort only
  }
}
