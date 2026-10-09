import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  card,
  cleanEnv,
  cleanupTempDirs,
  cloneWorkspace,
  commitAll,
  initRepo,
  installStubs,
  makeTempDir,
  readFile,
  runNodeAsync,
  scriptPath,
  setStubPlan,
  throwOnLogPreload,
  writeFile,
} from "./test-support/ci-fixture.mjs";

const guard = scriptPath("pr-board-guard.mjs");
const CARD = ".github/cards/stories/_orphan/S-1.md";
const HISTORY = ".github/plans/cards/sync-history.jsonl";
let template;
let baseSha;
let preload;

before(() => {
  template = makeTempDir("hyperion-pr-guard-tpl-");
  initRepo(template);
  installStubs(template, ["validate.mjs", "sync.mjs"]);
  writeFile(template, CARD, card({ id: "S-1", status: "Backlog" }));
  baseSha = commitAll(template, "base");
  // PR branch edit: forward-pending status change, not yet on the board.
  writeFile(template, CARD, card({ id: "S-1", status: "In Progress" }));
  commitAll(template, "pr edit");
  preload = throwOnLogPreload(makeTempDir("hyperion-pr-guard-preload-"));
});

after(cleanupTempDirs);

async function run({ plan = {}, args = [], env = {}, files = {}, execArgv = [] } = {}) {
  const ws = cloneWorkspace(template);
  setStubPlan(ws, plan);
  for (const [rel, content] of Object.entries(files)) writeFile(ws, rel, content);
  const r = await runNodeAsync(guard, args, { cwd: ws, env: cleanEnv(env), execArgv });
  return { ...r, ws };
}

const history = (ws) =>
  readFile(ws, HISTORY)
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("pr-board-guard.mjs", { concurrency: 6 }, () => {
  test("--skip and CARDS_PR_GUARD_SKIP pass without running anything", async () => {
    for (const opts of [{ args: ["--skip"] }, { env: { CARDS_PR_GUARD_SKIP: "true" } }]) {
      const r = await run(opts);
      assert.equal(r.status, 0, r.output);
      assert.match(r.stdout, /Skipped \(CARDS_PR_GUARD_SKIP \/ --skip\)/);
      assert.doesNotMatch(r.stdout, /STUB/);
    }
  });

  test("missing projectNumber is fatal when required", async () => {
    const r = await run({ env: { CARDS_CI_REQUIRE_PROJECT: "true" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[pr-guard\] FATAL: CI pull-before-push requires a GitHub Project: set projectNumber in projects-map\.json or the PROJECT_NUMBER env/);
  });

  test("validation failure is fatal with the validator's exit code", async () => {
    const r = await run({ plan: { "validate.mjs": [{ exit: 2 }] } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /FATAL: card validation failed/);
  });

  test("reverse sync failure is fatal", async () => {
    const r = await run({ plan: { "sync.mjs": [{ exit: 9 }] } });
    assert.equal(r.status, 9);
    assert.match(r.stderr, /FATAL: reverse sync failed/);
  });

  test("dry-run reverses with --dry-run/DRY_RUN and skips the guard", async () => {
    const r = await run({ args: ["--dry-run"], plan: { "sync.mjs": [{ write: { [CARD]: card({ id: "S-1", status: "Done" }) } }] } });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /STUB sync\.mjs#1 args=\[--dry-run --reverse\] DRY_RUN=true/);
    assert.match(r.stdout, /PR board guard complete \(dry-run\)\./);
    assert.equal(existsSync(join(r.ws, HISTORY)), false);
  });

  test("forward-pending PR edit (board still on the base value) is allowed and logged", async () => {
    const r = await run({
      env: { CARDS_GUARD_BASE_REF: baseSha },
      plan: { "sync.mjs": [{ write: { [CARD]: card({ id: "S-1", status: "Backlog" }) } }] },
    });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, new RegExp(`Directional base ref: ${baseSha.slice(0, 12)}…`));
    assert.match(r.stdout, /PR branch guard passed/);
    const [event] = history(r.ws);
    assert.equal(event.type, "pr-guard");
    assert.equal(event.ok, true);
    assert.equal(event.repository, "acme/app");
    assert.equal(event.backend, "github");
    assert.equal(event.baseRef, baseSha.slice(0, 12));
  });

  test("external board move blocks the merge and logs pr-guard-fail", async () => {
    const r = await run({
      env: { CARDS_GUARD_BASE_REF: baseSha, GITHUB_REPOSITORY: undefined },
      plan: { "sync.mjs": [{ write: { [CARD]: card({ id: "S-1", status: "In Progress", priority: "High" }) } }] },
    });
    assert.equal(r.status, 1, r.output);
    assert.match(r.stdout, /S-1\.md → priority: branch=Medium board=High/);
    assert.match(r.stderr, /merge blocked — external board drift on PR branch/);
    const [event] = history(r.ws);
    assert.equal(event.type, "pr-guard-fail");
    assert.equal(event.ok, false);
    assert.equal(event.reason, "external-drift");
    assert.equal(event.repository, "unknown/unknown");
  });

  test("without a base env the merge-base with main is used", async () => {
    const r = await run({ plan: { "sync.mjs": [{ write: { [CARD]: card({ id: "S-1", status: "Done" }) } }] } });
    assert.equal(r.status, 1, r.output);
    assert.match(r.stdout, /status: branch=In Progress board=Done/);
  });

  test("history logging is best-effort (unwritable plans dir does not fail the guard)", async () => {
    const r = await run({ files: { ".github/plans": "not a directory" } });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /PR branch guard passed/);
  });

  test("unexpected errors in main are reported as FATAL ERROR", async () => {
    const r = await run({ execArgv: ["--import", preload], env: { HYPERION_TEST_THROW_ON_LOG: "Step 1/3" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[pr-guard\] FATAL ERROR/);
  });
});
