#!/usr/bin/env node
/**
 * Hyperion process-guard — mechanical SDD gate for /implement|/execute|/review|/smoke.
 *
 * Multi-surface (Cursor / Copilot / Claude / CI): skills and agents call this script;
 * it is not a Claude-only UserPromptSubmit hook.
 *
 * Modes:
 *   --check implement|execute   Allow without BDD spec, but mark pending-sync.
 *   --check review|smoke        Block (exit 2) while pending-sync is set.
 *   --clear                     Drop the pending marker (after a real /spec).
 *   --status                    Print card/spec/pending state (exit 0).
 *
 * Card id: --card CARD_ID, else first id in argv, else branch name.
 * Spec: .github/plans/specs/{card_id}/ (or {card_id}-*) with Scenario/Cenário.
 * Pending state lives under .git/hyperion-state/ (local only).
 *
 * Bypass: HYPERION_SKIP_PROCESS_GUARD=1
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveHyperionPaths } from "./paths.mjs";

const COMMANDS = new Set(["implement", "execute", "review", "smoke"]);
const CARD_ID_RE = /[A-Z][A-Z0-9]+(?:-[A-Z0-9]+){1,}/;

export function parseArgs(argv = process.argv.slice(2)) {
  let check = "";
  let card = "";
  let clear = false;
  let status = false;
  let root = process.cwd();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") check = String(argv[++i] || "").toLowerCase();
    else if (a === "--card") card = String(argv[++i] || "").trim();
    else if (a === "--clear") clear = true;
    else if (a === "--status") status = true;
    else if (a === "--root") root = path.resolve(argv[++i] || root);
    else if (a === "--help" || a === "-h") return { help: true };
    else if (!a.startsWith("-")) positional.push(a);
  }
  if (!check && positional[0] && COMMANDS.has(positional[0].toLowerCase())) {
    check = positional.shift().toLowerCase();
  }
  if (!card) {
    for (const p of positional) {
      const m = String(p).toUpperCase().match(CARD_ID_RE);
      if (m) {
        card = m[0];
        break;
      }
    }
  }
  return { check, card, clear, status, root, help: false };
}

function git(cwd, args) {
  try {
    return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

export function resolveCardId(explicit, workspaceRoot) {
  if (explicit) return explicit;
  const branch = git(workspaceRoot, ["symbolic-ref", "--short", "HEAD"]);
  const m = branch.toUpperCase().match(CARD_ID_RE);
  return m ? m[0] : "";
}

export function statePaths(workspaceRoot) {
  const common = git(workspaceRoot, ["rev-parse", "--git-common-dir"]) || ".git";
  const gitDir = path.isAbsolute(common) ? common : path.join(workspaceRoot, common);
  const dir = path.join(gitDir, "hyperion-state");
  return { dir, pendingFile: path.join(dir, "pending-sync") };
}

export function readPending(workspaceRoot) {
  const { pendingFile } = statePaths(workspaceRoot);
  try {
    return fs.readFileSync(pendingFile, "utf8").trim() || "";
  } catch {
    return "";
  }
}

export function writePending(workspaceRoot, cardId) {
  const { dir, pendingFile } = statePaths(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pendingFile, `${cardId}\n`, "utf8");
}

export function clearPending(workspaceRoot) {
  const { pendingFile } = statePaths(workspaceRoot);
  try {
    fs.unlinkSync(pendingFile);
    return true;
  } catch {
    return false;
  }
}

function listSpecDirs(specsRoot, cardId) {
  if (!cardId || !fs.existsSync(specsRoot)) return [];
  const exact = path.join(specsRoot, cardId);
  const out = [];
  if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) out.push(exact);
  try {
    for (const name of fs.readdirSync(specsRoot)) {
      if (name === cardId || !name.startsWith(`${cardId}-`)) continue;
      const p = path.join(specsRoot, name);
      if (fs.statSync(p).isDirectory()) out.push(p);
    }
  } catch {
    /* missing */
  }
  return out;
}

function specHasScenarios(specDir) {
  try {
    for (const name of fs.readdirSync(specDir)) {
      if (!/\.(md|markdown)$/i.test(name)) continue;
      const text = fs.readFileSync(path.join(specDir, name), "utf8");
      if (/^\s*(Scenario|Cenário|Cenario)\s*:/im.test(text) || /\b(Given|Dado)\b/i.test(text)) return true;
    }
  } catch {
    /* empty */
  }
  return false;
}

export function findCardHit(cardsRoot, cardId) {
  if (!cardId || !fs.existsSync(cardsRoot)) return "";
  const needle = cardId.toLowerCase();
  const stack = [cardsRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "_examples" || e.name === "node_modules") continue;
        stack.push(p);
      } else if (e.isFile() && e.name.toLowerCase().includes(needle) && e.name.endsWith(".md")) {
        return p;
      }
    }
  }
  return "";
}

/**
 * @returns {{
 *   cardId: string,
 *   cardPath: string,
 *   specDir: string,
 *   hasSpec: boolean,
 *   pending: string,
 *   pendingCleared: boolean,
 * }}
 */
export function inspectProcess(workspaceRoot, cardId) {
  const paths = resolveHyperionPaths(workspaceRoot);
  const specsRoot = path.join(paths.kitRoot, ".github", "plans", "specs");
  const cardsRoot = paths.cardsRoot;
  const dirs = listSpecDirs(specsRoot, cardId);
  const withScenarios = dirs.find(specHasScenarios) || "";
  let pending = readPending(workspaceRoot);
  let pendingCleared = false;
  if (pending && withScenarios) {
    const pendingId = pending.toUpperCase().match(CARD_ID_RE)?.[0] || pending;
    if (!cardId || pendingId === cardId || withScenarios.includes(pendingId) || path.basename(withScenarios).startsWith(pendingId)) {
      clearPending(workspaceRoot);
      pending = "";
      pendingCleared = true;
    }
  }
  return {
    cardId,
    cardPath: findCardHit(cardsRoot, cardId),
    specDir: withScenarios || dirs[0] || "",
    hasSpec: Boolean(withScenarios),
    pending,
    pendingCleared,
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/hyperion/process-guard.mjs --check implement|execute|review|smoke [--card CARD_ID]
  node scripts/hyperion/process-guard.mjs --status [--card CARD_ID]
  node scripts/hyperion/process-guard.mjs --clear

Exit: 0 ok/warn, 2 blocked, 1 usage/error.
Bypass: HYPERION_SKIP_PROCESS_GUARD=1`);
}

export function runGuard(opts) {
  if (process.env.HYPERION_SKIP_PROCESS_GUARD === "1") {
    console.log("[process-guard] skipped (HYPERION_SKIP_PROCESS_GUARD=1)");
    return 0;
  }
  const workspaceRoot = path.resolve(opts.root || process.cwd());
  if (opts.clear) {
    const cleared = clearPending(workspaceRoot);
    console.log(cleared ? "[process-guard] pending-sync cleared" : "[process-guard] no pending-sync marker");
    return 0;
  }

  const cardId = resolveCardId(opts.card, workspaceRoot);
  const info = inspectProcess(workspaceRoot, cardId);

  if (opts.status || !opts.check) {
    console.log(`[process-guard] card_id: ${info.cardId || "(none)"}`);
    console.log(`[process-guard] card: ${info.cardPath || "(missing)"}`);
    console.log(`[process-guard] spec: ${info.hasSpec ? info.specDir : "(no BDD scenarios)"}`);
    console.log(`[process-guard] pending: ${info.pending || "(none)"}`);
    if (info.pendingCleared) console.log("[process-guard] pending cleared — BDD spec now present");
    return 0;
  }

  if (!COMMANDS.has(opts.check)) {
    console.error(`[process-guard] unknown --check ${opts.check}`);
    return 1;
  }

  if (info.pendingCleared) {
    console.log(`[process-guard] BDD spec found for ${info.cardId || "feature"} — pending-sync cleared`);
  }

  if (opts.check === "implement" || opts.check === "execute") {
    if (!cardId) {
      console.log("[process-guard] WARN: no CARD_ID on branch/args — prefer /refine or name the card before coding");
      return 0;
    }
    if (info.hasSpec) {
      console.log(`[process-guard] Spec BDD OK for ${cardId} at ${info.specDir}. Proceed.`);
      return 0;
    }
    writePending(workspaceRoot, cardId);
    console.log("");
    console.log(`[process-guard] ${opts.check} without BDD spec for ${cardId} (allowed).`);
    console.log(`  Marked pending-sync. Generate .github/plans/specs/${cardId}/ (Scenario/Cenário) before /review or /smoke.`);
    console.log("  Prefer /spec then /spec-review. Retroactive spec from code is OK — clear happens automatically once scenarios exist.");
    console.log("");
    return 0;
  }

  // review | smoke
  if (info.pending) {
    console.error("");
    console.error(`[process-guard] BLOCKED: /${opts.check} while pending-sync is set (${info.pending}).`);
    console.error("  /implement or /execute ran without a BDD acceptance spec.");
    console.error(`  Add scenarios under .github/plans/specs/${info.pending}/ (or matching ${info.pending}-*/), then retry.`);
    console.error("  Or: npm run hyperion:process-guard -- --clear  (only if you intentionally skip SDD)");
    console.error("");
    return 2;
  }

  if (cardId && !info.hasSpec) {
    console.log(`[process-guard] WARN: no BDD spec for ${cardId} — /${opts.check} may lack scenario coverage. Prefer /spec.`);
  } else if (cardId && info.hasSpec) {
    console.log(`[process-guard] Spec OK for ${cardId}.`);
  }
  return 0;
}

async function main() {
  const opts = parseArgs();
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  process.exit(runGuard(opts));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("[process-guard] FATAL:", err.message);
    process.exit(1);
  });
}
