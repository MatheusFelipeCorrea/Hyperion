#!/usr/bin/env node
/**
 * Report PR board-guard result as a GitHub Check Run (for scheduled recheck / webhooks).
 *
 * Usage (after pr-board-guard.mjs):
 *   node report-pr-guard-check.mjs --head-sha SHA --base-sha SHA --conclusion success|failure
 *
 * Env:
 *   GITHUB_REPOSITORY  — owner/repo
 *   GITHUB_TOKEN       — checks:write
 *   CARDS_PR_CHECK_NAME — check name (default: board-guard)
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const paths = resolveHyperionPaths(process.cwd());

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function parseRepo() {
  const slug = process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY required (owner/repo)");
  return { owner, repo };
}

async function createCheckRun({ owner, repo, token, headSha, name, conclusion, summary }) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/check-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      name,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title: conclusion === "success" ? "Board guard passed" : "Board drift detected",
        summary,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Check run API failed (${response.status}): ${text}`);
  }
}

async function main() {
  const headSha = argValue("--head-sha") || process.env.CARDS_PR_HEAD_SHA;
  const baseSha = argValue("--base-sha") || process.env.GITHUB_BASE_SHA || process.env.CARDS_GUARD_BASE_REF;
  const checkName = process.env.CARDS_PR_CHECK_NAME || "board-guard";
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (!headSha) {
    console.error("[report-check] FATAL: --head-sha or CARDS_PR_HEAD_SHA required");
    process.exit(1);
  }
  if (!token) {
    console.error("[report-check] FATAL: GITHUB_TOKEN required");
    process.exit(1);
  }

  const { owner, repo } = parseRepo();
  const guardScript = path.join(paths.kitRoot, "scripts", "cards-sync", "pr-board-guard.mjs");

  const env = {
    ...process.env,
    GITHUB_BASE_SHA: baseSha || "",
    CARDS_GUARD_BASE_REF: baseSha || "",
    CARDS_CI_STRICT_GIT: process.env.CARDS_CI_STRICT_GIT || "true",
  };

  const result = spawnSync(process.execPath, [guardScript], {
    cwd: paths.workspaceRoot,
    stdio: "inherit",
    env,
  });

  const code = result.status ?? 1;
  const conclusion = code === 0 ? "success" : "failure";
  const summary =
    conclusion === "success"
      ? "Directional board guard passed — no external drift on this commit."
      : "External board drift detected. Run `npm run cards:reverse`, commit, and push.";

  await createCheckRun({
    owner,
    repo,
    token,
    headSha,
    name: checkName,
    conclusion,
    summary,
  });

  console.log(`[report-check] Posted check "${checkName}" → ${conclusion} on ${headSha.slice(0, 7)}`);
  process.exit(code);
}

main().catch((error) => {
  console.error("[report-check] FATAL ERROR");
  console.error(error);
  process.exit(1);
});
