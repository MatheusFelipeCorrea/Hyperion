import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  boardLabel,
  checkDirectionalBoardAlignment,
  evaluateBoardAlignment,
  listCardDiffFilesAfterReverse,
  normalizeSyncFieldValue,
  parseFrontmatterForGuard,
  printBoardDriftHelp,
  resolveGuardBaseRef,
} from "./board-guard.mjs";
import { checkBoardRepoAlignment } from "./lib.mjs";
import { card, cleanupTempDirs, commitAll, git, initRepo, makeTempDir, writeFile } from "./test-support/ci-fixture.mjs";

const GUARD_ENV = ["CARDS_GUARD_BASE_REF", "GITHUB_BASE_SHA", "GITHUB_EVENT_BEFORE", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME", "CARDS_CI_STRICT_GIT", "CARDS_SYNC_MODE", "HYPERION_ROOT"];
const savedEnv = Object.fromEntries(GUARD_ENV.map((k) => [k, process.env[k]]));
const savedCwd = process.cwd();
const P = ".github/cards/stories/_orphan";

before(() => {
  for (const k of GUARD_ENV) delete process.env[k];
  // printBoardDriftHelp resolves the language from cwd — keep it off the host repo's config.
  process.chdir(makeTempDir("hyperion-guard-cwd-"));
});

after(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  cleanupTempDirs();
});

function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Git can't be spawned: drives the fail-open / strict-git branches. */
async function withoutGit(fn) {
  const prev = process.env.PATH;
  process.env.PATH = "";
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

function repoWithCommits(branch = "main", count = 2) {
  const dir = initRepo(makeTempDir("hyperion-guard-repo-"), branch);
  const shas = [];
  for (let i = 0; i < count; i++) {
    writeFile(dir, `f${i}.txt`, `${i}\n`);
    shas.push(commitAll(dir, `c${i}`));
  }
  return { dir, shas };
}

test("boardLabel covers every backend and defaults to GitHub", () => {
  assert.equal(boardLabel("gitlab"), "GitLab board");
  assert.equal(boardLabel("azure"), "Azure DevOps board");
  assert.equal(boardLabel("Azure-DevOps"), "Azure DevOps board");
  assert.equal(boardLabel(undefined), "GitHub Project board");
  assert.equal(boardLabel("something-else"), "GitHub Project board");
});

test("parseFrontmatterForGuard handles block lists, inline lists, null and trailing lists", () => {
  const meta = parseFrontmatterForGuard(
    [
      "---",
      "categories:",
      "  - Backend",
      "  - \"API\"",
      '  - ""',
      "status: null",
      "labels: [A, 'B', ]",
      "empty:",
      "priority: High",
      "tags:",
      "  - x",
      "---",
      "body",
    ].join("\r\n")
  );
  assert.deepEqual(meta.categories, ["Backend", "API"]);
  assert.equal(meta.status, null);
  assert.deepEqual(meta.labels, ["A", "B"]);
  assert.deepEqual(meta.empty, []);
  assert.equal(meta.priority, "High");
  assert.deepEqual(meta.tags, ["x"]);
  assert.equal(parseFrontmatterForGuard("# no frontmatter"), null);
  assert.equal(parseFrontmatterForGuard(undefined), null);
});

test("normalizeSyncFieldValue normalizes numbers, scalars and empty lists", () => {
  assert.equal(normalizeSyncFieldValue("story_points", "3.0"), "3");
  assert.equal(normalizeSyncFieldValue("story_points", " big "), "big");
  assert.equal(normalizeSyncFieldValue("categories", []), null);
  assert.equal(normalizeSyncFieldValue("categories", " Solo "), "Solo");
  assert.equal(normalizeSyncFieldValue("status", ""), null);
  assert.equal(normalizeSyncFieldValue("status", undefined), null);
  assert.equal(normalizeSyncFieldValue("status", " Done "), "Done");
});

test("resolveGuardBaseRef: env override, MR target / main merge-base, then HEAD~1", () => {
  const { dir, shas } = repoWithCommits("main", 2);
  git(dir, "checkout", "-q", "-b", "feature");
  writeFile(dir, "feature.txt", "f\n");
  const featureHead = commitAll(dir, "feature");

  assert.equal(resolveGuardBaseRef(dir, "post-forward"), "HEAD");
  withEnv({ CARDS_GUARD_BASE_REF: "deadbeef" }, () => assert.equal(resolveGuardBaseRef(dir), "deadbeef"));
  withEnv({ GITHUB_BASE_SHA: "cafe" }, () => assert.equal(resolveGuardBaseRef(dir, "pr"), "cafe"));
  withEnv({ GITHUB_EVENT_BEFORE: "0".repeat(40) }, () =>
    assert.equal(resolveGuardBaseRef(dir), shas[1], "zero sha (new branch push) is ignored → HEAD~1")
  );
  withEnv({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" }, () => assert.equal(resolveGuardBaseRef(dir, "pr"), shas[1]));
  withEnv({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "missing-branch" }, () => assert.equal(resolveGuardBaseRef(dir, "pr"), shas[1]));

  git(dir, "branch", "-m", "main", "trunk");
  assert.equal(resolveGuardBaseRef(dir, "pr"), shas[1], "no main branch → parent commit");
  assert.notEqual(featureHead, shas[1]);
});

test("resolveGuardBaseRef falls back to HEAD on a root commit; clean tree is aligned", () => {
  const { dir } = repoWithCommits("main", 1);
  assert.equal(resolveGuardBaseRef(dir, "main-pre-forward"), "HEAD");
  assert.deepEqual(checkBoardRepoAlignment(dir), { aligned: true, files: [], gitAvailable: true });
});

test("checkDirectionalBoardAlignment separates external drift from forward-pending edits", async () => {
  const dir = initRepo(makeTempDir("hyperion-guard-dir-"));
  writeFile(dir, `${P}/A.md`, card({ id: "A", status: "Backlog" }));
  writeFile(dir, `${P}/B.md`, card({ id: "B", status: "Backlog" }));
  writeFile(dir, `${P}/E.md`, card({ id: "E" }));
  writeFile(dir, ".github/cards/notes.txt", "n\n");
  const base = commitAll(dir, "base");
  writeFile(dir, `${P}/A.md`, card({ id: "A", status: "In Progress" })); // forward-pending on the branch
  commitAll(dir, "branch");

  // Reverse sync results (board state) in the working tree:
  writeFile(dir, `${P}/A.md`, card({ id: "A", status: "Backlog" })); // board not updated yet → allowed
  writeFile(dir, `${P}/B.md`, card({ id: "B", status: "Done" })); // board moved alone → drift
  rmSync(join(dir, P, "E.md")); // listed by git diff but unreadable → skipped
  writeFile(dir, `${P}/D.md`, card({ id: "D" }));
  git(dir, "add", `${P}/D.md`); // staged only, not in HEAD → skipped
  writeFile(dir, `${P}/D.md`, card({ id: "D", status: "Done" }));
  writeFile(dir, ".github/cards/notes.txt", "changed\n");

  const result = await checkDirectionalBoardAlignment(dir, ".github/cards/", { baseRef: base, ignoreFields: [] });
  assert.equal(result.aligned, false);
  assert.equal(result.gitAvailable, true);
  assert.equal(result.baseRef, base);
  assert.deepEqual(result.files, [`${P}/B.md`]);
  assert.deepEqual(result.externalDrifts, [{ file: `${P}/B.md`, fields: [{ field: "status", head: "Backlog", base: "Backlog", board: "Done" }] }]);

  // Auto sync mode (from project.yml) ignores board-owned status drift.
  writeFile(dir, ".github/project.yml", "ci:\n  hyperion:\n    cards_sync_mode: auto\n");
  const auto = await checkDirectionalBoardAlignment(dir, ".github/cards", { baseRef: base });
  assert.equal(auto.aligned, true);
  assert.deepEqual(auto.files.sort(), [`${P}/A.md`, `${P}/B.md`, `${P}/D.md`, `${P}/E.md`], "no drift → every changed card file, no .txt");

  const post = await checkDirectionalBoardAlignment(dir, ".github/cards", { context: "post-forward" });
  assert.equal(post.aligned, false);
  assert.deepEqual(post.externalDrifts, []);
  assert.equal(post.files.length, 4);

  assert.equal(listCardDiffFilesAfterReverse(dir, ".github/cards").files.length, 4);
  const simple = checkBoardRepoAlignment(dir, ".github/cards");
  assert.equal(simple.aligned, false);
  assert.equal(simple.gitAvailable, true);
  assert.equal(simple.files.length, 4);
});

test("card files with non-ASCII names are still guarded (git path quoting)", async () => {
  const dir = initRepo(makeTempDir("hyperion-guard-utf8-"));
  const file = `${P}/Ação-1.md`;
  writeFile(dir, file, card({ id: "Ação-1", status: "Backlog" }));
  const base = commitAll(dir, "base");
  writeFile(dir, file, card({ id: "Ação-1", status: "Done" }));

  const result = await checkDirectionalBoardAlignment(dir, ".github/cards", { baseRef: base, ignoreFields: [] });
  assert.equal(result.aligned, false);
  assert.deepEqual(result.externalDrifts, [{ file, fields: [{ field: "status", head: "Backlog", base: "Backlog", board: "Done" }] }]);
  assert.deepEqual(listCardDiffFilesAfterReverse(dir, ".github/cards").files, [file]);
  assert.deepEqual(checkBoardRepoAlignment(dir, ".github/cards"), { aligned: false, files: [file], gitAvailable: true });
});

test("git unavailable: fail-open by default, fail-closed with strictGit", async () => {
  const dir = makeTempDir("hyperion-guard-nogit-");
  await withoutGit(async () => {
    const open = await checkDirectionalBoardAlignment(dir, ".github/cards", { ignoreFields: [] });
    assert.equal(open.aligned, true);
    assert.equal(open.skipped, true);
    assert.equal(open.gitAvailable, false);
    assert.ok(open.warning);

    const strict = await checkDirectionalBoardAlignment(dir, ".github/cards", { strictGit: true });
    assert.equal(strict.aligned, false);
    assert.equal(strict.gitAvailable, false);
    assert.equal(strict.skipped, undefined);

    assert.ok(listCardDiffFilesAfterReverse(dir).error);
    const simple = checkBoardRepoAlignment(dir);
    assert.equal(simple.gitAvailable, false);
    assert.equal(simple.aligned, true);
  });
});

test("printBoardDriftHelp: post-forward and main contexts, changed-file listing, null drift values", () => {
  const post = [];
  printBoardDriftHelp(["a.md"], "jira", "post-forward", (m) => post.push(m), [], "en");
  assert.ok(post.some((l) => l.includes("After forward sync, the Jira board still differs")));
  assert.ok(post.includes("  - a.md"));

  const main = [];
  printBoardDriftHelp([], "linear", "main-pre-forward", (m) => main.push(m), [{ file: "x.md", fields: [{ field: "sprint", head: null, board: null }] }], "en");
  assert.ok(main.some((l) => l.includes("The Linear board has external changes not in this commit.")));
  assert.ok(main.some((l) => /git commit -m "chore\(cards\): pull board state before sync"/.test(l)));
  assert.ok(main.includes("  - x.md → sprint: branch=null board=null"));

  const defaults = [];
  const original = console.log;
  console.log = (m) => defaults.push(m);
  try {
    printBoardDriftHelp(["b.md"], "github");
  } finally {
    console.log = original;
  }
  assert.ok(defaults.includes("  - b.md"));
});

test("evaluateBoardAlignment: fail-open warning, default console logger, base ref note", () => {
  const lines = [];
  const logFn = (m) => lines.push(m);
  withEnv({ CARDS_CI_STRICT_GIT: undefined }, () => {
    const warned = evaluateBoardAlignment({ aligned: true, files: [], warning: "spawn git ENOENT", skipped: true }, { logFn });
    assert.deepEqual(warned, { ok: true, skipped: true });
  });
  assert.ok(lines.some((l) => l.includes("WARN: git diff unavailable (spawn git ENOENT)")));

  withEnv({ CARDS_CI_STRICT_GIT: "true" }, () => {
    assert.deepEqual(evaluateBoardAlignment({ aligned: true, skipped: true }, { logFn }), { ok: true, skipped: true }, "skipped without a warning is not fatal");
  });

  const passed = evaluateBoardAlignment({ aligned: true, files: [], baseRef: "0123456789abcdef" }, { logFn, context: "pr" });
  assert.equal(passed.ok, true);
  assert.ok(lines.includes("Board guard passed (base 0123456) — no external drift (pr)."));

  const printed = [];
  const original = console.log;
  console.log = (m) => printed.push(m);
  try {
    const failed = evaluateBoardAlignment({ aligned: false, files: ["c.md"] }, { backend: "gitlab" });
    assert.equal(failed.ok, false);
  } finally {
    console.log = original;
  }
  assert.ok(printed.includes(""));
  assert.ok(printed.includes("  - c.md"));
  assert.ok(printed.some((l) => l.includes("GitLab board")));
});
