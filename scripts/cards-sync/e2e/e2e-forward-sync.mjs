#!/usr/bin/env node
/**
 * E2E forward-sync smoke test — OPT-IN ONLY. Performs REAL, LIVE mutations.
 * ============================================================================
 *
 * `sync.test.mjs` / `lib.test.mjs` are unit tests: the only "network" path
 * mocks `global.fetch`, so nothing ever hits a real GitHub API. This script
 * closes that gap by running the *actual* `sync.mjs` forward sync against a
 * *disposable* GitHub repo and checking the resulting Issue for real.
 *
 * It creates real GitHub Issues (and one throwaway label) in whatever repo
 * E2E_TARGET_REPO points at, then deletes them again in a `finally` block.
 * NEVER point it at a repo you care about, and never wire it into a
 * push/PR-triggered workflow — see .github/workflows/hyperion-e2e-cards.yml
 * for the only sanctioned (workflow_dispatch, manual) trigger.
 *
 * Usage (local):
 *   E2E_TARGET_REPO="your-user/hyperion-e2e-sandbox" \
 *   E2E_GITHUB_TOKEN="ghp_xxx" \
 *     node scripts/cards-sync/e2e/e2e-forward-sync.mjs
 *
 * Env:
 *   E2E_TARGET_REPO   (required) "owner/repo" of a disposable repo you own,
 *                     created specifically for this test. Never the repo
 *                     this script itself lives in.
 *   E2E_GITHUB_TOKEN  (required, or PROJECT_SYNC_TOKEN as a fallback) — a
 *                     PAT scoped to E2E_TARGET_REPO with "Issues: Read and
 *                     write" + "Contents: Read".
 *
 * What it does:
 *   1. Creates 1-2 throwaway card files under a temp `.github/cards/` tree
 *      (config points sync.mjs at E2E_TARGET_REPO, autoCreateProject/
 *      autoDiscoverProject disabled so this stays Issues-only — no
 *      GitHub Project board is touched).
 *   2. Spawns the real scripts/cards-sync/sync.mjs forward sync (no
 *      --dry-run) against that temp tree, exactly like ci-sync.mjs invokes
 *      it — not a reimplementation of the sync logic.
 *   3. Verifies the resulting GitHub issue(s): title, labels, body
 *      (CARD_ID sync marker).
 *   4. Cleans up — deletes the issue(s) and the throwaway label it created —
 *      in a try/finally so cleanup runs even when an assertion fails.
 *
 * This file is intentionally NOT named `*.test.mjs` and lives outside
 * scripts/cards-sync/*.test.mjs, so `npm test` / `npm run cards:test` never
 * picks it up and never runs it automatically.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { detectRepoFromGit } from "../lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const syncScriptPath = path.join(scriptDir, "..", "sync.mjs");

function log(message) {
  console.log(`[e2e-forward-sync] ${message}`);
}

function fail(message) {
  console.error(`[e2e-forward-sync] ERROR: ${message}`);
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
      "This test runs a REAL forward sync that creates real GitHub issues, so it",
      "needs a disposable test repo you own — never the repo this script lives in.",
      "",
      '  E2E_TARGET_REPO="your-user/hyperion-e2e-sandbox" \\',
      '  E2E_GITHUB_TOKEN="ghp_xxx" \\',
      "    node scripts/cards-sync/e2e/e2e-forward-sync.mjs",
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

// Normalize before ANY use (split, same-repo guard, or passing downstream) —
// "owner/repo.git" and "owner/repo" must compare as identical, or a target
// repo pasted straight from a git remote URL slips past the same-repo guard.
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
// Minimal GitHub GraphQL/REST helpers for verification + cleanup only.
// (The actual sync mutation is delegated to the real sync.mjs below — this
// is not a second implementation of the sync, just read/delete for the test.)
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

async function deleteLabelIfExists(labelName) {
  const response = await fetch(
    `https://api.github.com/repos/${targetOwner}/${targetName}/labels/${encodeURIComponent(labelName)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "cards-sync-e2e-test",
      },
    }
  );
  if (response.status !== 204 && response.status !== 404) {
    log(`  WARN: could not delete label "${labelName}" (HTTP ${response.status})`);
  }
}

async function findIssueByCardId(cardId) {
  // Same shape as sync.mjs's loadIssueMapByCardId: list issues and match on
  // the CARD_ID sync marker in the body — no search-index lag to worry about.
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
  return nodes.find((issue) => issue.body?.includes(`CARD_ID: ${cardId}`)) || null;
}

async function deleteIssue(issueId) {
  await ghGraphql(
    `mutation($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { clientMutationId } }`,
    { issueId }
  );
}

// ---------------------------------------------------------------------------
// Test fixture — throwaway cards + a run-unique label so cleanup is safe.
// ---------------------------------------------------------------------------

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storyCardId = `E2E-STORY-${runId}`;
const taskCardId = `E2E-TASK-${runId}`;
const e2eLabel = `hyperion-e2e-${runId}`;

async function buildFixtureWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hyperion-e2e-"));
  const cardsRoot = path.join(tempRoot, ".github", "cards");

  await fs.mkdir(path.join(cardsRoot, "config"), { recursive: true });
  await fs.mkdir(path.join(cardsRoot, "stories", "_orphan"), { recursive: true });
  await fs.mkdir(path.join(cardsRoot, "tasks", storyCardId), { recursive: true });

  const projectsMap = {
    default: {
      projectOwner: targetOwner,
      // Issues-only test: never touch a GitHub Project board.
      projectNumber: 0,
      autoDiscoverProject: false,
      autoCreateProject: false,
      locale: "en",
      defaults: { status: "Backlog" },
    },
  };
  await fs.writeFile(
    path.join(cardsRoot, "config", "projects-map.json"),
    JSON.stringify(projectsMap, null, 2) + "\n",
    "utf8"
  );

  const storyCard = `---
card_id: ${storyCardId}
title: "Hyperion E2E forward-sync smoke test"
status: Backlog
type: Story
priority: Medium
sprint: null
story_points: null
reporter: null
parent: null
due_date: null
categories:
  - ${e2eLabel}
---

# [STORY] Hyperion E2E forward-sync smoke test

This throwaway card was created by \`scripts/cards-sync/e2e/e2e-forward-sync.mjs\`
to verify that a real forward sync creates a GitHub issue correctly. It — and its
child task — are deleted automatically at the end of the run. If you see this
issue lingering, the E2E script's cleanup step failed; delete it manually.

## Sub-issues

- ${taskCardId}
`;
  await fs.writeFile(path.join(cardsRoot, "stories", "_orphan", `${storyCardId}.md`), storyCard, "utf8");

  const taskCard = `---
card_id: ${taskCardId}
title: "Hyperion E2E forward-sync smoke test (child task)"
status: Backlog
type: Task
priority: Medium
sprint: null
story_points: null
reporter: null
parent: ${storyCardId}
due_date: null
categories: []
---

# [TASK] Hyperion E2E forward-sync smoke test (child task)

Throwaway child card — see ${storyCardId}. Deleted automatically at the end of the run.
`;
  await fs.writeFile(path.join(cardsRoot, "tasks", storyCardId, `${taskCardId}.md`), taskCard, "utf8");

  return tempRoot;
}

// ---------------------------------------------------------------------------
// Invoke the real sync — same pattern ci-sync.mjs uses (spawn, inherit stdio).
// ---------------------------------------------------------------------------

function runRealForwardSync(workspaceRoot) {
  log(`Running real forward sync against ${targetRepo}...`);
  const result = spawnSync(process.execPath, [syncScriptPath, "--forward"], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: normalizedTargetRepo,
      PROJECT_SYNC_TOKEN: token,
      GITHUB_TOKEN: "",
      CREATE_MISSING_LABELS: "true",
      DRY_RUN: "false",
      SYNC_DIRECTION: "forward",
    },
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`Real forward sync exited with status ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function verifyStoryIssue() {
  const issue = await findIssueByCardId(storyCardId);
  assert(issue, `expected an open GitHub issue with CARD_ID: ${storyCardId}`);
  assert(
    issue.title === "[Story] Hyperion E2E forward-sync smoke test",
    `unexpected issue title: "${issue.title}"`
  );
  const labelNames = (issue.labels?.nodes || []).map((l) => l.name);
  assert(
    labelNames.includes(e2eLabel),
    `expected label "${e2eLabel}" on issue #${issue.number}, got [${labelNames.join(", ")}]`
  );
  assert(issue.body.includes(`CARD_ID: ${storyCardId}`), "issue body missing CARD_ID sync marker");
  assert(
    issue.body.includes(`SOURCE_FILE:`),
    "issue body missing SOURCE_FILE sync marker"
  );
  log(`  OK: story issue #${issue.number} — title, label, and CARD_ID/SOURCE_FILE markers verified`);
  return issue;
}

async function verifyTaskIssue() {
  const issue = await findIssueByCardId(taskCardId);
  assert(issue, `expected an open GitHub issue with CARD_ID: ${taskCardId}`);
  assert(
    issue.title === "[Task] Hyperion E2E forward-sync smoke test (child task)",
    `unexpected issue title: "${issue.title}"`
  );
  assert(issue.body.includes(`PARENT_CARD_ID: ${storyCardId}`), "task issue body missing PARENT_CARD_ID marker");
  log(`  OK: task issue #${issue.number} — title and PARENT_CARD_ID marker verified`);
  return issue;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Target repo: ${targetRepo}`);
  log(`Story card: ${storyCardId} / Task card: ${taskCardId} / Label: ${e2eLabel}`);

  let workspaceRoot = null;
  const createdIssueIds = [];

  try {
    workspaceRoot = await buildFixtureWorkspace();
    log(`Fixture workspace: ${workspaceRoot}`);

    runRealForwardSync(workspaceRoot);

    const storyIssue = await verifyStoryIssue();
    createdIssueIds.push(storyIssue.id);

    const taskIssue = await verifyTaskIssue();
    createdIssueIds.push(taskIssue.id);

    log("All assertions passed.");
  } finally {
    log("Cleaning up...");
    for (const issueId of createdIssueIds) {
      try {
        await deleteIssue(issueId);
        log(`  Deleted issue node ${issueId}`);
      } catch (error) {
        log(`  WARN: could not delete issue node ${issueId}: ${error.message}`);
      }
    }
    try {
      await deleteLabelIfExists(e2eLabel);
      log(`  Deleted label "${e2eLabel}" (if it existed)`);
    } catch (error) {
      log(`  WARN: could not delete label "${e2eLabel}": ${error.message}`);
    }
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      log(`  Removed fixture workspace ${workspaceRoot}`);
    }
  }
}

main()
  .then(() => {
    log("E2E forward-sync test PASSED.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("[e2e-forward-sync] FAILED");
    console.error(error);
    process.exit(1);
  });
