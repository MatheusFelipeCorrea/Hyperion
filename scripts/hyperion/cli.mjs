#!/usr/bin/env node
/**
 * Hyperion CLI — maps subcommands to scripts/hyperion/*.mjs (and cards-sync).
 * Used by: npm run hyperion … · bin/hyperion · Docker ENTRYPOINT
 *
 *   hyperion help
 *   hyperion doctor
 *   hyperion project-verify
 *   hyperion cards sync
 */
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kitHyperionDir = __dirname;
const kitCardsDir = path.join(__dirname, "..", "cards-sync");
const workspaceRoot = process.cwd();

/** @type {Record<string, { script: string, dir?: "hyperion" | "cards", desc: string }>} */
export const COMMANDS = {
  help: { script: "help.mjs", desc: "List npm / agent shortcuts" },
  doctor: { script: "doctor.mjs", desc: "Kit + cards health" },
  setup: { script: "setup.mjs", desc: "Bootstrap cards / setup" },
  sync: { script: "sync.mjs", desc: "Validate + sync cards (hyperion wrapper)" },
  init: { script: "init.mjs", desc: "Local kit checklist" },
  upgrade: { script: "upgrade.mjs", desc: "Upgrade kit from GitHub origin" },
  cursor: { script: "install-cursor-rules.mjs", desc: "Install Cursor rules" },
  "repo-detect": { script: "repo-detect.mjs", desc: "Detect test/lint/build" },
  "pipeline-detect": { script: "pipeline-detect.mjs", desc: "Detect CI" },
  "pipeline-plan": { script: "pipeline-plan.mjs", desc: "Plan hyperion workflows" },
  "pipeline-apply": { script: "pipeline-apply.mjs", desc: "Apply hyperion workflows" },
  "phase-verify": { script: "phase-verify.mjs", desc: "Gate /execute Verification" },
  "project-verify": { script: "project-verify.mjs", desc: "Gate project.yml" },
  "review-verify": { script: "review-verify.mjs", desc: "Gate PR review artifact" },
  "generate-rules": { script: "generate-runtime-rules.mjs", desc: "Regen runtime rules" },
  "check-rules": { script: "generate-runtime-rules.mjs", desc: "Check rules drift" },
  "skills-eval": { script: "skills-eval.mjs", desc: "Structural skills eval" },
  "skills-catalog": { script: "skills-catalog.mjs", desc: "Generate skills catalog" },
  "docs-check": { script: "docs-check.mjs", desc: "Markdown link check" },
  "docs-prose-check": { script: "docs-prose-check.mjs", desc: "Docs prose drift check" },
  "skills-validate": { script: "skills-validate.mjs", desc: "Validate skill frontmatter" },
  "llm-eval": { script: "llm-eval.mjs", desc: "LLM eval fixtures" },
  "distribution-purity-check": { script: "distribution-purity-check.mjs", desc: "No binding to this repo" },
  "adopt-check": { script: "adopt-check.mjs", desc: "No leftover Hyperion identity in your repo" },
  telemetry: { script: "telemetry.mjs", desc: "Local opt-in agent-gate usage summary" },
  "spec-review-verify": { script: "spec-review-verify.mjs", desc: "Gate /spec-review artifact" },
  "audit-verify": { script: "audit-verify.mjs", desc: "Gate /audit-run summary" },
  "plan-verify": { script: "plan-verify.mjs", desc: "Gate /implement plan" },
  "release-verify": { script: "release-verify.mjs", desc: "Gate /release artifact" },
  "install-shims": { script: "install-product-shims.mjs", desc: "Install product npm shims" },
};

// Every `hyperion:*`/`docs:*`/`skills:*` npm script must have a matching
// COMMANDS entry — this file and package.json are two lists of the same
// thing kept in sync by hand, and that's exactly how the count of missing
// commands here kept drifting (6 → 7 → 8) across audit rounds without
// anyone catching it. See cli.test.mjs for the parity test that now
// guards this.

const CARDS_COMMANDS = {
  sync: { script: "sync.mjs", desc: "cards:sync" },
  "dry-run": { script: "sync.mjs", desc: "cards dry-run", args: ["--dry-run"] },
  reverse: { script: "sync.mjs", desc: "cards reverse", args: ["--reverse"] },
  doctor: { script: "doctor.mjs", desc: "cards:doctor", args: ["--interactive"] },
  validate: { script: "validate.mjs", desc: "cards:validate" },
  init: { script: "init.mjs", desc: "cards:init" },
  watch: { script: "watch.mjs", desc: "cards:watch" },
  metrics: { script: "metrics.mjs", desc: "cards:metrics" },
  history: { script: "history.mjs", desc: "cards:history" },
};

export function resolveCommand(argv) {
  const args = [...argv];
  if (args[0] === "cards") {
    const sub = args[1] || "sync";
    const rest = args.slice(2);
    const spec = CARDS_COMMANDS[sub];
    if (!spec) return { error: `Unknown cards subcommand: ${sub}` };
    return {
      dir: "cards",
      script: spec.script,
      forward: [...(spec.args || []), ...rest],
      label: `cards ${sub}`,
    };
  }
  const name = args[0] || "help";
  const rest = args.slice(1);
  if (name === "--help" || name === "-h") {
    return { dir: "hyperion", script: "help.mjs", forward: [], label: "help" };
  }
  const spec = COMMANDS[name];
  if (!spec) return { error: `Unknown command: ${name}. Try: hyperion help` };
  const forward = name === "check-rules" ? ["--check", ...rest] : rest;
  return { dir: "hyperion", script: spec.script, forward, label: name };
}

function printCliHelp() {
  console.log("Hyperion CLI — same scripts as npm run hyperion:*\n");
  console.log("Usage: hyperion <command> [args]");
  console.log("       hyperion cards <sync|doctor|validate|…>\n");
  console.log("Commands:");
  for (const [k, v] of Object.entries(COMMANDS)) {
    console.log(`  ${k.padEnd(18)} ${v.desc}`);
  }
  console.log("\nRuntime: Node 20+ on host, or Docker image hyperion-cli (see docs).");
}

function runResolved(resolved) {
  const base = resolved.dir === "cards" ? kitCardsDir : kitHyperionDir;
  const scriptPath = path.join(base, resolved.script);
  if (!existsSync(scriptPath)) {
    console.error(`[Hyperion] Script missing: ${scriptPath}`);
    console.error("Copy the Hyperion kit (scripts/) into this repo first.");
    return 1;
  }
  const result = spawnSync(process.execPath, [scriptPath, ...resolved.forward], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  return result.status ?? 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "cli-help" || argv[0] === "commands") {
    printCliHelp();
    process.exit(0);
  }
  const resolved = resolveCommand(argv);
  if (resolved.error) {
    console.error(`[Hyperion] ${resolved.error}`);
    printCliHelp();
    process.exit(1);
  }
  process.exit(runResolved(resolved));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main();
}