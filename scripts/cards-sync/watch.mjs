import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cardIdFromRelativePath, isNonSyncCardPath, isKitSampleCardId } from "./lib.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";
import { detectDefaultBranch } from "../hyperion/pipeline-lib.mjs";

const hyperionPaths = resolveHyperionPaths(process.cwd());
const workspaceRoot = hyperionPaths.workspaceRoot;
const cardsRoot = hyperionPaths.cardsRoot;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

let debounceTimer = null;
let running = false;
let pendingIds = new Set();
let queued = false;

function log(message) {
  console.log(`[cards-watch] ${message}`);
}

function runNodeScript(scriptName, extraEnv = {}) {
  const scriptPath = path.join(scriptDir, scriptName);
  const env = { ...process.env, ...extraEnv };
  if (hyperionPaths.kitRootRel) {
    env.HYPERION_ROOT = hyperionPaths.kitRootRel;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: workspaceRoot,
      stdio: "inherit",
      env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} exited with code ${code}`));
    });
  });
}

export function isDefaultBranch(root = workspaceRoot) {
  if (String(process.env.CARDS_WATCH_ANY_BRANCH || "").toLowerCase() === "true") return true;
  try {
    const branch = execSync("git branch --show-current", {
      encoding: "utf8",
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // Fail closed: an undetectable branch (detached HEAD, git error) must not
    // be treated as the default branch — that would let a real sync run
    // against an unknown checkout state.
    if (!branch) return false;
    const defaultBranch = detectDefaultBranch(root);
    return branch === defaultBranch || branch === "main" || branch === "master";
  } catch {
    return false;
  }
}

export function isLiveSyncAllowed() {
  return String(process.env.CARDS_WATCH_LIVE || "").toLowerCase() === "true";
}

async function runPipeline() {
  if (running) {
    queued = true;
    log("Sync already running — queued for next pass.");
    return;
  }

  running = true;
  const ids = [...pendingIds];
  pendingIds.clear();

  try {
    log("Validating cards...");
    await runNodeScript("validate.mjs");

    if (!isDefaultBranch()) {
      log(
        "Skipping forward sync — not on default branch (or branch could not be detected). After board moves run: npm run cards:reverse → commit → merge. Override: CARDS_WATCH_ANY_BRANCH=true"
      );
      log("Done (validate only).");
      return;
    }

    const extraEnv = ids.length ? { CARDS_SYNC_ONLY: ids.join(",") } : {};

    if (!isLiveSyncAllowed()) {
      log(
        "DRY RUN — no board will be written. This is the default so a watcher left running never surprises you with a real sync. Set CARDS_WATCH_LIVE=true to sync for real."
      );
      await runNodeScript("sync.mjs", { ...extraEnv, DRY_RUN: "true" });
      log("Done (dry-run).");
      return;
    }

    if (ids.length) {
      log(`Incremental sync (LIVE): ${ids.join(", ")}`);
    } else {
      log("Syncing all cards (LIVE)...");
    }
    // CARDS_SYNC_YES skips sync.mjs's own interactive confirmation — the
    // user already made that call once, explicitly, via CARDS_WATCH_LIVE.
    // Re-prompting on every debounced file change would defeat the point
    // of an unattended watcher.
    await runNodeScript("sync.mjs", { ...extraEnv, CARDS_SYNC_YES: "true" });

    log("Done.");
  } catch (error) {
    log(`Failed: ${error.message}`);
  } finally {
    running = false;
    if (queued || pendingIds.size) {
      queued = false;
      scheduleRun("queued changes");
    }
  }
}

function registerChange(filename) {
  if (!filename) return;
  if (!filename.endsWith(".md") && !filename.endsWith(".json")) return;

  if (filename.endsWith(".md")) {
    const normalized = filename.replace(/\\/g, "/");
    if (isNonSyncCardPath(normalized)) return;
    const id = cardIdFromRelativePath(normalized);
    if (id && !isKitSampleCardId(id)) pendingIds.add(id);
  }
}

function scheduleRun(label) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    log(`Change detected${label ? `: ${label}` : ""}`);
    runPipeline();
  }, 600);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (!fs.existsSync(cardsRoot)) {
    console.error(`[cards-watch] ${hyperionPaths.cardsPrefix}/ not found. Run from product repo root (or set kit.root).`);
    process.exit(1);
  }

  log(`Watching ${path.relative(workspaceRoot, cardsRoot)}/ (recursive, incremental)`);
  log(
    isLiveSyncAllowed()
      ? "LIVE mode — real board writes on every change (CARDS_WATCH_LIVE=true)."
      : "Dry-run mode (default) — no board writes. Set CARDS_WATCH_LIVE=true to sync for real."
  );
  log("Press Ctrl+C to stop.");

  fs.watch(cardsRoot, { recursive: true }, (_event, filename) => {
    registerChange(filename || "");
    scheduleRun(filename || "");
  });
}
