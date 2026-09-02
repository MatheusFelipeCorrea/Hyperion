#!/usr/bin/env node
/**
 * PR / MR board guard — reverse → directional diff → fail on external board drift.
 *
 * Forward-pending edits in the PR (e.g. status change not yet on board) are allowed.
 * External board moves (board changed, branch did not) block merge.
 *
 * Env:
 *   CARDS_CI_REQUIRE_PROJECT=true  — fail if projectNumber missing (GitHub only)
 *   GITHUB_BASE_SHA                — PR base commit (set by workflow)
 *   CARDS_GUARD_BASE_REF           — override base ref for directional compare
 *   DRY_RUN=true                   — skip reverse writes; guard always passes
 *   CARDS_PR_GUARD_SKIP=true       — escape hatch (pass without check)
 *   CARDS_CI_STRICT_GIT=true       — fail when git unavailable
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";
import {
  detectRepoFromGit,
  assertCiProjectConfigured,
  readSyncBackendHint,
} from "./lib.mjs";
import {
  evaluateBoardAlignment,
  checkDirectionalBoardAlignment,
  resolveGuardBaseRef,
} from "./board-guard.mjs";

const paths = resolveHyperionPaths(process.cwd());

const dryRun =
  process.argv.includes("--dry-run") || String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const skipGuard =
  process.argv.includes("--skip") || String(process.env.CARDS_PR_GUARD_SKIP || "false").toLowerCase() === "true";

function log(message) {
  console.log(`[pr-guard] ${message}`);
}

function syncScript(name) {
  return path.join(paths.kitRoot, "scripts", "cards-sync", name);
}

function runScript(scriptName, args = [], extraEnv = {}) {
  const scriptPath = syncScript(scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: paths.workspaceRoot,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  return result.status ?? 1;
}

async function main() {
  if (skipGuard) {
    log("Skipped (CARDS_PR_GUARD_SKIP / --skip).");
    process.exit(0);
  }

  const repositorySlug = process.env.GITHUB_REPOSITORY || detectRepoFromGit() || "unknown/unknown";
  const backend = await readSyncBackendHint({
    projectYmlPath: paths.projectYmlPath,
    projectsMapPath: paths.projectsMapPath,
    repositorySlug,
  });

  log(`Workspace: ${paths.workspaceRoot}`);
  log(`Cards prefix: ${paths.cardsPrefix}`);
  log(`Backend: ${backend}`);
  log(`Dry-run: ${dryRun ? "yes" : "no"}`);

  const projectCheck = await assertCiProjectConfigured(paths.projectsMapPath, repositorySlug, { backend });
  if (!projectCheck.ok) {
    console.error(`[pr-guard] FATAL: ${projectCheck.message}`);
    process.exit(1);
  }

  const baseRef = resolveGuardBaseRef(paths.workspaceRoot, "pr");
  log(`Directional base ref: ${baseRef.slice(0, 12)}…`);

  log("Step 1/3: validate cards");
  const validateCode = runScript("validate.mjs");
  if (validateCode !== 0) {
    console.error("[pr-guard] FATAL: card validation failed");
    process.exit(validateCode);
  }

  log("Step 2/3: reverse sync (pull board → markdown on PR branch)");
  const reverseArgs = ["--reverse"];
  if (dryRun) reverseArgs.unshift("--dry-run");
  const reverseCode = runScript("sync.mjs", reverseArgs, dryRun ? { DRY_RUN: "true" } : {});
  if (reverseCode !== 0) {
    console.error("[pr-guard] FATAL: reverse sync failed");
    process.exit(reverseCode);
  }

  if (dryRun) {
    log("Dry-run — board alignment guard skipped (no file writes).");
    log("PR board guard complete (dry-run).");
    process.exit(0);
  }

  log("Step 3/3: directional board ↔ PR branch check");
  const strictGit = String(process.env.CARDS_CI_STRICT_GIT || "false").toLowerCase() === "true";
  const alignment = await checkDirectionalBoardAlignment(paths.workspaceRoot, paths.cardsPrefix, {
    context: "pr",
    baseRef,
    strictGit,
  });

  const result = evaluateBoardAlignment(alignment, { backend, context: "pr", logFn: log });

  if (!result.ok) {
    console.error("[pr-guard] FATAL: merge blocked — external board drift on PR branch");
    process.exit(1);
  }

  log("PR branch guard passed — forward-pending edits allowed, no external board drift.");
}

main().catch((error) => {
  console.error("[pr-guard] FATAL ERROR");
  console.error(error);
  process.exit(1);
});
