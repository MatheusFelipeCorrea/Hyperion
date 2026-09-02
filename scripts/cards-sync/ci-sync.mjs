#!/usr/bin/env node
/**
 * CI cards sync — pull → verify → push (like git pull, check, git push).
 *
 * 1. Reverse sync (board → markdown frontmatter)
 * 2. git diff guard — fail if board diverged from committed cards
 * 3. Forward sync (markdown → board)
 * 4. Post-forward verify — reverse again; retry forward once if board drift remains
 *
 * Env:
 *   CARDS_CI_REQUIRE_PROJECT=true  — fail if projectNumber missing (GitHub only)
 *   DRY_RUN=true                   — dry-run reverse + forward; guard always passes
 *   CARDS_CI_SKIP_REVERSE=true     — forward-only (escape hatch)
 *   CARDS_CI_SKIP_BOARD_GUARD=true — skip git diff guard
 *   CARDS_CI_SKIP_POST_VERIFY=true — skip post-forward verify/retry
 *   CARDS_CI_STRICT_GIT=true        — fail when git diff unavailable (don't fail-open)
 *   CARDS_GUARD_BASE_REF=<sha>      — override merge-base / parent ref for directional guard
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const paths = resolveHyperionPaths(process.cwd());

const dryRun =
  process.argv.includes("--dry-run") || String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const skipReverse =
  process.argv.includes("--skip-reverse") ||
  String(process.env.CARDS_CI_SKIP_REVERSE || "false").toLowerCase() === "true";
const skipGuard =
  process.argv.includes("--skip-board-guard") ||
  String(process.env.CARDS_CI_SKIP_BOARD_GUARD || "false").toLowerCase() === "true";
const skipPostVerify =
  process.argv.includes("--skip-post-verify") ||
  String(process.env.CARDS_CI_SKIP_POST_VERIFY || "false").toLowerCase() === "true";

function log(message) {
  console.log(`[ci-sync] ${message}`);
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

function checkAlignmentOrExit({ backend, phase }) {
  const context = phase === "post-forward" ? "post-forward" : "main-pre-forward";
  const strictGit = String(process.env.CARDS_CI_STRICT_GIT || "false").toLowerCase() === "true";
  const baseRef =
    context === "post-forward" ? "HEAD" : resolveGuardBaseRef(paths.workspaceRoot, context);

  return checkDirectionalBoardAlignment(paths.workspaceRoot, paths.cardsPrefix, {
    context,
    baseRef,
    strictGit,
  }).then((alignment) => {
    const result = evaluateBoardAlignment(alignment, { backend, context, logFn: log });
    return result.ok;
  });
}

async function main() {
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
  log(`Mode: ${skipReverse ? "forward-only" : "pull → verify → push"}`);

  const projectCheck = await assertCiProjectConfigured(paths.projectsMapPath, repositorySlug, { backend });
  if (!projectCheck.ok) {
    console.error(`[ci-sync] FATAL: ${projectCheck.message}`);
    process.exit(1);
  }
  if (projectCheck.projectNumber) {
    log(`Project configured: #${projectCheck.projectNumber}`);
  } else if (projectCheck.skipped && projectCheck.reason === "not_github_backend") {
    log("projectNumber check skipped (non-GitHub backend).");
  }

  log("Step 1/4: validate cards");
  const validateCode = runScript("validate.mjs");
  if (validateCode !== 0) {
    console.error("[ci-sync] FATAL: card validation failed");
    process.exit(validateCode);
  }

  if (!skipReverse) {
    log("Step 2/4: reverse sync (pull board → markdown)");
    const reverseArgs = ["--reverse"];
    if (dryRun) reverseArgs.unshift("--dry-run");
    const reverseCode = runScript("sync.mjs", reverseArgs, dryRun ? { DRY_RUN: "true" } : {});
    if (reverseCode !== 0) {
      console.error("[ci-sync] FATAL: reverse sync failed");
      process.exit(reverseCode);
    }

    if (!skipGuard && !dryRun) {
      log("Step 2b/4: board ↔ repo alignment check (pre-forward, directional)");
      if (!(await checkAlignmentOrExit({ backend, phase: "pre-forward" }))) {
        process.exit(1);
      }
    } else if (dryRun) {
      log("Dry-run — board alignment guard skipped (no file writes).");
    }
  } else {
    log("Step 2/4: skipped reverse (--skip-reverse / CARDS_CI_SKIP_REVERSE)");
  }

  log("Step 3/4: forward sync (push markdown → board)");
  const forwardArgs = ["--forward"];
  if (dryRun) forwardArgs.unshift("--dry-run");
  let forwardCode = runScript("sync.mjs", forwardArgs, dryRun ? { DRY_RUN: "true" } : {});
  if (forwardCode !== 0) {
    console.error("[ci-sync] FATAL: forward sync failed");
    process.exit(forwardCode);
  }

  if (!skipPostVerify && !skipReverse && !skipGuard && !dryRun) {
    log("Step 4/4: post-forward verify (reverse + alignment check)");

    const verifyReverse = async () => {
      const reverseCode = runScript("sync.mjs", ["--reverse"]);
      if (reverseCode !== 0) {
        console.error("[ci-sync] FATAL: post-forward reverse sync failed");
        process.exit(reverseCode);
      }
      return checkAlignmentOrExit({ backend, phase: "post-forward" });
    };

    if (!(await verifyReverse())) {
      log("Post-forward drift detected — retrying forward sync once...");
      forwardCode = runScript("sync.mjs", ["--forward"]);
      if (forwardCode !== 0) {
        console.error("[ci-sync] FATAL: forward retry failed");
        process.exit(forwardCode);
      }
      if (!(await verifyReverse())) {
        console.error("[ci-sync] FATAL: board still diverges after forward retry");
        process.exit(1);
      }
      log("Post-forward verify passed after retry.");
    } else {
      log("Post-forward verify passed.");
    }
  } else if (skipPostVerify) {
    log("Step 4/4: skipped post-forward verify");
  } else {
    log("Step 4/4: skipped post-forward verify (dry-run / skip-reverse / skip-guard)");
  }

  log("CI cards sync complete.");
}

main().catch((error) => {
  console.error("[ci-sync] FATAL ERROR");
  console.error(error);
  process.exit(1);
});
