#!/usr/bin/env node
/**
 * E2E reverse-sync smoke test — OPT-IN ONLY. Performs REAL, LIVE mutations.
 * ============================================================================
 *
 * Companion to e2e-forward-sync.mjs, same safety envelope (disposable repo
 * only, workflow_dispatch only, same-repo guard, cleanup in `finally`) — see
 * that file's header for the full rationale. This one closes the other
 * direction: forward-sync's unit tests never verify that a change made on
 * the *board* actually flows back into the local markdown file for real.
 *
 * What it does:
 *   1. Runs a real forward sync to create one throwaway GitHub issue (same
 *      fixture-card approach as e2e-forward-sync.mjs) — this also doubles
 *      as continued forward-sync coverage, not just setup.
 *   2. Edits that issue directly via the GitHub API — new title, one label
 *      added — simulating a human editing it on the board, not through
 *      this kit.
 *   3. Deletes the local card file, so reverse sync has to recreate it from
 *      scratch (the harder of the two reverse-sync paths — patching an
 *      existing file is the easier one and already implicitly exercised
 *      any time a maintainer runs `cards:reverse` locally).
 *   4. Spawns the real scripts/cards-sync/sync.mjs reverse sync (no
 *      --dry-run) and checks the *recreated* local file's title and
 *      categories reflect the board edit.
 *   5. Cleans up — deletes the issue and its throwaway label in a `finally`
 *      block, same as forward.
 *
 * Deliberately scoped to title/label roundtrip, not status: this fixture is
 * Issues-only (no GitHub Project board, same as e2e-forward-sync.mjs), and
 * without a Project's Status field there's no real board-driven status
 * source to verify — testing it here would mean faking the exact thing the
 * test is supposed to prove works for real.
 *
 * Usage (local):
 *   E2E_TARGET_REPO="your-user/hyperion-e2e-sandbox" \
 *   E2E_GITHUB_TOKEN="ghp_xxx" \
 *     node scripts/cards-sync/e2e/e2e-reverse-sync.mjs
 *
 * Env: same as e2e-forward-sync.mjs (E2E_TARGET_REPO, E2E_GITHUB_TOKEN or
 * PROJECT_SYNC_TOKEN fallback).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { detectRepoFromGit, parseCardIdFromIssueBody, pickCanonicalIssueForCardId } from "../lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const syncScriptPath = path.join(scriptDir, "..", "sync.mjs");

function log(message) {
  console.log(`[e2e-reverse-sync] ${message}`);
}

function fail(message) {
  console.error(`[e2e-reverse-sync] ERROR: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Fail fast on missing configuration — before anything is created anywhere.
// ---------------------------------------------------------------------------

const targetRepo = process.env.E2E_TARGET_REPO;
const token = process.env.E2E_GITHUB_TOKEN || process.env.PROJECT_SYNC_TOKEN;

if (!targetRepo) {
  fail(
    [
      "E2E_TARGET_REPO is not set.",
      "",
      "This test runs a REAL forward + reverse sync against a disposable test",
      "repo you own — never the repo this script lives in.",
      "",
      '  E2E_TARGET_REPO="your-user/hyperion-e2e-sandbox" \\',
      '  E2E_GITHUB_TOKEN="ghp_xxx" \\',
      "    node scripts/cards-sync/e2e/e2e-reverse-sync.mjs",
      "",
      "See scripts/cards-sync/README.md → 'End-to-end test (opt-in)' for setup steps.",
    ].join("\n")
  );
}

if (!token) {
  fail(
    [
      "No token found. Set E2E_GITHUB_TOKEN (preferred) or PROJECT_SYNC_TOKEN.",
      "",
      "Needs a PAT scoped to E2E_TARGET_REPO with:",
      "  - Issues: Read and write",
      "  - Contents: Read",
    ].join("\n")
  );
}

function normalizeRepoSlug(slug) {
  return String(slug || "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

const normalizedTargetRepo = normalizeRepoSlug(targetRepo);
const [targetOwner, targetName] = normalizedTargetRepo.split("/");
if (!targetOwner || !targetName) {
  fail(`E2E_TARGET_REPO must be "owner/repo" — got "${targetRepo}".`);
}

const currentRepoSlug = normalizeRepoSlug(process.env.GITHUB_REPOSITORY || detectRepoFromGit());
if (currentRepoSlug && currentRepoSlug.toLowerCase() === normalizedTargetRepo.toLowerCase()) {
  fail(
    `E2E_TARGET_REPO ("${targetRepo}") is the same repo this script is running from ` +
      "(" +
      currentRepoSlug +
      "). Refusing to run — point this at a separate, disposable test repo instead."
  );
}

// ---------------------------------------------------------------------------
// Minimal GitHub GraphQL/REST helpers — verification, board-edit simulation,
// and cleanup only. The actual sync mutations are delegated to the real
// sync.mjs below, not reimplemented here.
// ---------------------------------------------------------------------------

async function ghGraphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "cards-sync-e2e-test",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GraphQL failed: ${JSON.stringify(payload.errors || payload, null, 2)}`);
  }
  return payload.data;
}

async function updateIssueTitleAndLabels(issueId, issueNumber, newTitle, addLabel) {
  await ghGraphql(
    `mutation($issueId: ID!, $title: String!) { updateIssue(input: { id: $issueId, title: $title }) { clientMutationId } }`,
    { issueId, title: newTitle }
  );
  await fetch(`https://api.github.com/repos/${targetOwner}/${targetName}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "cards-sync-e2e-test",
    },
    body: JSON.stringify({ labels: [addLabel] }),
  });
}

async function deleteLabelIfExists(labelName) {
  const response = await fetch(
    `https://api.github.com/repos/${targetOwner}/${targetName}/labels/${encodeURIComponent(labelName)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "User-Agent": "cards-sync-e2e-test" } }
  );
  if (response.status !== 204 && response.status !== 404) {
    log(`  WARN: could not delete label "${labelName}" (HTTP ${response.status})`);
  }
}

async function findIssueByCardId(cardId) {
  const data = await ghGraphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        issues(first: 50, states: [OPEN, CLOSED], orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { id number title url body state labels(first: 20) { nodes { name } } }
        }
      }
    }`,
    { owner: targetOwner, name: targetName }
  );
  const nodes = data.repository?.issues?.nodes || [];
  let match = null;
  for (const issue of nodes) {
    if (parseCardIdFromIssueBody(issue.body) !== cardId) continue;
    match = pickCanonicalIssueForCardId(match, issue);
  }
  return match;
}

async function deleteIssue(issueId) {
  await ghGraphql(`mutation($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { clientMutationId } }`, {
    issueId,
  });
}

// ---------------------------------------------------------------------------
// Fixture — one throwaway task card, run-unique so cleanup is safe.
// ---------------------------------------------------------------------------

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const taskCardId = `E2E-REVERSE-${runId}`;
const originalTitle = "Hyperion E2E reverse-sync smoke test";
const editedTitle = "Hyperion E2E reverse-sync smoke test (edited on the board)";
const originalLabel = `hyperion-e2e-reverse-${runId}`;
const addedLabel = `hyperion-e2e-reverse-added-${runId}`;
const sourceFileRel = path.posix.join(".github", "cards", "tasks", "_orphan", `${taskCardId}.md`);

function fixtureProjectsMap() {
  return {
    default: {
      projectOwner: targetOwner,
      projectNumber: 0, // Issues-only — never touches a Project board, same as forward E2E.
      autoDiscoverProject: false,
      autoCreateProject: false,
      locale: "en",
      defaults: { status: "Backlog" },
    },
  };
}

async function buildWorkspaceWithCard() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hyperion-e2e-reverse-"));
  const cardsRoot = path.join(tempRoot, ".github", "cards");
  await fs.mkdir(path.join(cardsRoot, "config"), { recursive: true });
  await fs.mkdir(path.join(cardsRoot, "tasks", "_orphan"), { recursive: true });
  await fs.writeFile(
    path.join(cardsRoot, "config", "projects-map.json"),
    `${JSON.stringify(fixtureProjectsMap(), null, 2)}\n`,
    "utf8"
  );
  const card = `---
card_id: ${taskCardId}
title: "${originalTitle}"
status: Backlog
type: Task
priority: Medium
sprint: null
story_points: null
reporter: null
parent: null
due_date: null
categories:
  - ${originalLabel}
---

# [TASK] ${originalTitle}

Throwaway card created by \`scripts/cards-sync/e2e/e2e-reverse-sync.mjs\`. Deleted
automatically at the end of the run — if you see this lingering, cleanup failed.
`;
  await fs.writeFile(path.join(cardsRoot, "tasks", "_orphan", `${taskCardId}.md`), card, "utf8");
  return tempRoot;
}

function runRealSync(workspaceRoot, direction) {
  log(`Running real ${direction} sync against ${targetRepo}...`);
  const result = spawnSync(process.execPath, [syncScriptPath, direction === "forward" ? "--forward" : "--reverse"], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: normalizedTargetRepo,
      PROJECT_SYNC_TOKEN: token,
      GITHUB_TOKEN: "",
      CREATE_MISSING_LABELS: "true",
      DRY_RUN: "false",
      SYNC_DIRECTION: direction,
    },
  });
  const status = result.status ?? 1;
  if (status !== 0) throw new Error(`Real ${direction} sync exited with status ${status}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  log(`Target repo: ${targetRepo}`);
  log(`Task card: ${taskCardId} / labels: ${originalLabel}, ${addedLabel}`);

  let workspaceRoot = null;
  let issueId = null;

  try {
    workspaceRoot = await buildWorkspaceWithCard();
    log(`Fixture workspace: ${workspaceRoot}`);

    runRealSync(workspaceRoot, "forward");

    const created = await findIssueByCardId(taskCardId);
    assert(created, `expected a GitHub issue with CARD_ID: ${taskCardId} after forward sync`);
    issueId = created.id;
    log(`  Created issue #${created.number}`);

    log("Editing the issue directly via the API (simulating a board-side edit)...");
    await updateIssueTitleAndLabels(issueId, created.number, editedTitle, addedLabel);

    const localCardPath = path.join(workspaceRoot, sourceFileRel);
    await fs.rm(localCardPath, { force: true });
    log(`  Deleted local card file — reverse sync must recreate it from the board`);

    runRealSync(workspaceRoot, "reverse");

    const recreated = await fs.readFile(localCardPath, "utf8");
    assert(
      recreated.includes(`title: "${editedTitle}"`) || recreated.includes(`# [TASK] ${editedTitle}`) || recreated.includes(editedTitle),
      `recreated local card doesn't reflect the board-edited title "${editedTitle}"`
    );
    assert(
      new RegExp(`categories:[\\s\\S]*?-\\s*${addedLabel}`).test(recreated) || recreated.includes(addedLabel),
      `recreated local card doesn't include the label added on the board ("${addedLabel}")`
    );
    assert(recreated.includes(`card_id: ${taskCardId}`), "recreated local card lost its card_id");
    log("  OK: recreated local card reflects the board's title and label edit");

    log("All assertions passed.");
  } finally {
    log("Cleaning up...");
    if (issueId) {
      try {
        await deleteIssue(issueId);
        log(`  Deleted issue node ${issueId}`);
      } catch (error) {
        log(`  WARN: could not delete issue node ${issueId}: ${error.message}`);
      }
    }
    for (const label of [originalLabel, addedLabel]) {
      try {
        await deleteLabelIfExists(label);
        log(`  Deleted label "${label}" (if it existed)`);
      } catch (error) {
        log(`  WARN: could not delete label "${label}": ${error.message}`);
      }
    }
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      log(`  Removed fixture workspace ${workspaceRoot}`);
    }
  }
}

main()
  .then(() => {
    log("E2E reverse-sync test PASSED.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("[e2e-reverse-sync] FAILED");
    console.error(error);
    process.exit(1);
  });
