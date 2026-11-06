#!/usr/bin/env node
/**
 * Kit-only promotion guard for the Hyperion repository: work lands in `dev`,
 * and the long-lived branches only move forward one step at a time
 * (dev → qa → main → internal). Any other PR into qa/main/internal fails with
 * a message that says where the PR should go instead.
 *
 * CI: BASE_REF, HEAD_REF, HEAD_REPO, BASE_REPO come from the pull_request_target
 * event (branch-flow.yml runs this file from the base branch, never the PR's head).
 * An empty HEAD_REPO (deleted fork) is treated as a fork.
 * Local: node scripts/kit/branch-flow.mjs --base qa --head feat/x
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { errorAnnotation } from "./annotations.mjs";

export const PROMOTIONS = { qa: "dev", main: "qa", internal: "main" };

/** @returns {true | false | "unknown"} */
export function headRepoRelation(headRepo, baseRepo) {
  if (!headRepo || !baseRepo) return "unknown";
  return headRepo.toLowerCase() === baseRepo.toLowerCase();
}

/** @returns {{ ok: boolean, title?: string, message: string }} */
export function checkBranchFlow({ base, head, sameRepo = true }) {
  const expected = PROMOTIONS[base];
  if (!expected) return { ok: true, message: `PR into ${base}: no promotion rule, nothing to check.` };
  if (sameRepo === true && head === expected) return { ok: true, message: `${expected} → ${base}: allowed promotion.` };

  const from =
    sameRepo === true
      ? `'${head}'`
      : sameRepo === "unknown"
        ? `'${head}' of an unknown repository (the head fork was deleted or is not visible, so it is treated as a fork)`
        : `a fork ('${head}')`;
  const fix =
    base === "qa"
      ? `Change the PR's base branch to 'dev' (Edit next to the title → base: dev). Once it is merged, a maintainer promotes dev → qa.`
      : base === "main"
        ? `Merge it into 'dev' first; it reaches main through the dev → qa (QA release gate) → main promotion.`
        : `'internal' only receives main (opened automatically by internal-sync.yml). Target 'dev' instead.`;
  return {
    ok: false,
    title: `PR into ${base} must come from ${expected}`,
    message: `This PR goes from ${from} into '${base}', but '${base}' only accepts PRs from this repository's '${expected}' branch (flow: feature → dev → qa → main → internal). ${fix} See CONTRIBUTING.md → "Fluxo de branches".`,
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function main() {
  const headArg = argValue("--head");
  const base = argValue("--base") || process.env.BASE_REF || "";
  const head = headArg || process.env.HEAD_REF || "";
  // --head is a local dry check of this repository's own branches; from the event, the head repo must be proven.
  const sameRepo = headArg ? true : headRepoRelation(process.env.HEAD_REPO, process.env.BASE_REPO);
  if (!base || !head) {
    console.error(errorAnnotation("Branch flow", "Missing base/head. Usage: node scripts/kit/branch-flow.mjs --base <branch> --head <branch>"));
    process.exit(2);
  }
  const result = checkBranchFlow({ base, head, sameRepo });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Branch flow ${result.ok ? "✅" : "❌"}\n\n${result.message}\n`);
  }
  if (!result.ok) {
    console.error(errorAnnotation(result.title, result.message));
    process.exit(1);
  }
  console.log(result.message);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
