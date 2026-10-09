import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
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

const ciSync = scriptPath("ci-sync.mjs");
const CARD = ".github/cards/stories/_orphan/S-1.md";
const drifted = card({ id: "S-1", status: "Done" });
let template;
let preload;

before(() => {
  template = makeTempDir("hyperion-ci-sync-tpl-");
  initRepo(template);
  installStubs(template, ["validate.mjs", "sync.mjs"]);
  writeFile(template, CARD, card({ id: "S-1", status: "Backlog" }));
  commitAll(template, "seed");
  writeFile(template, "README.md", "second commit so HEAD~1 exists\n");
  commitAll(template, "second");
  preload = throwOnLogPreload(makeTempDir("hyperion-ci-sync-preload-"));
});

after(cleanupTempDirs);

async function run({ plan = {}, args = [], env = {}, files = {}, execArgv = [] } = {}) {
  const ws = cloneWorkspace(template);
  setStubPlan(ws, plan);
  for (const [rel, content] of Object.entries(files)) writeFile(ws, rel, content);
  const r = await runNodeAsync(ciSync, args, { cwd: ws, env: cleanEnv(env), execArgv });
  return { ...r, ws };
}

const stubCalls = (out) => out.match(/STUB \S+ args=\[[^\]]*\] DRY_RUN=\S*/g) || [];

describe("ci-sync.mjs", { concurrency: 6 }, () => {
  test("full pull → verify → push passes and reports the configured project", async () => {
    const r = await run({
      env: { CARDS_CI_REQUIRE_PROJECT: "true" },
      files: { ".github/cards/config/projects-map.json": JSON.stringify({ default: { projectNumber: 7 } }) },
    });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /Backend: github/);
    assert.match(r.stdout, /Mode: pull → verify → push/);
    assert.match(r.stdout, /Project configured: #7/);
    assert.match(r.stdout, /Board guard passed \(base [0-9a-f]{7}\) — no external drift \(main-pre-forward\)/);
    assert.match(r.stdout, /Post-forward verify passed\./);
    assert.match(r.stdout, /CI cards sync complete\./);
    assert.deepEqual(stubCalls(r.stdout), [
      "STUB validate.mjs#1 args=[] DRY_RUN=",
      "STUB sync.mjs#1 args=[--reverse] DRY_RUN=",
      "STUB sync.mjs#2 args=[--forward] DRY_RUN=",
      "STUB sync.mjs#3 args=[--reverse] DRY_RUN=",
    ]);
  });

  test("missing projectNumber is fatal when CARDS_CI_REQUIRE_PROJECT=true", async () => {
    const r = await run({ env: { CARDS_CI_REQUIRE_PROJECT: "true" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FATAL: CI pull-before-push requires projectNumber/);
    assert.equal(stubCalls(r.stdout).length, 0);
  });

  test("non-GitHub backend skips the project check; --skip-reverse goes forward-only", async () => {
    const r = await run({
      args: ["--skip-reverse"],
      env: { CARDS_CI_REQUIRE_PROJECT: "true", GITHUB_REPOSITORY: undefined },
      files: { ".github/project.yml": "management:\n  backend: linear\n" },
    });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /Backend: linear/);
    assert.match(r.stdout, /Mode: forward-only/);
    assert.match(r.stdout, /projectNumber check skipped \(non-GitHub backend\)\./);
    assert.match(r.stdout, /Step 2\/4: skipped reverse/);
    assert.match(r.stdout, /Step 4\/4: skipped post-forward verify \(dry-run \/ skip-reverse \/ skip-guard\)/);
    assert.deepEqual(stubCalls(r.stdout), ["STUB validate.mjs#1 args=[] DRY_RUN=", "STUB sync.mjs#1 args=[--forward] DRY_RUN="]);
  });

  test("validation failure stops the pipeline with the validator's exit code", async () => {
    const r = await run({ plan: { "validate.mjs": [{ exit: 3 }] } });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /FATAL: card validation failed/);
  });

  test("reverse sync failure is fatal", async () => {
    const r = await run({ plan: { "sync.mjs": [{ exit: 4 }] } });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /FATAL: reverse sync failed/);
  });

  test("external board drift after reverse blocks before forward sync", async () => {
    const r = await run({ plan: { "sync.mjs": [{ write: { [CARD]: drifted } }] } });
    assert.equal(r.status, 1, r.output);
    assert.match(r.stdout, /BOARD DRIFT DETECTED/);
    assert.match(r.stdout, /stories\/_orphan\/S-1\.md → status: branch=Backlog board=Done/);
    assert.equal(stubCalls(r.stdout).length, 2, "forward sync must not run");
  });

  test("dry-run passes --dry-run + DRY_RUN to sync and skips both guards", async () => {
    const r = await run({ args: ["--dry-run"], plan: { "sync.mjs": [{ write: { [CARD]: drifted } }] } });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /Dry-run: yes/);
    assert.match(r.stdout, /Dry-run — board alignment guard skipped/);
    assert.match(r.stdout, /Step 4\/4: skipped post-forward verify \(dry-run/);
    assert.deepEqual(stubCalls(r.stdout).slice(1), [
      "STUB sync.mjs#1 args=[--dry-run --reverse] DRY_RUN=true",
      "STUB sync.mjs#2 args=[--dry-run --forward] DRY_RUN=true",
    ]);
  });

  test("forward sync failure is fatal", async () => {
    const r = await run({ plan: { "sync.mjs": [{}, { exit: 5 }] } });
    assert.equal(r.status, 5);
    assert.match(r.stderr, /FATAL: forward sync failed/);
  });

  test("post-forward reverse failure is fatal", async () => {
    const r = await run({ plan: { "sync.mjs": [{}, {}, { exit: 6 }] } });
    assert.equal(r.status, 6);
    assert.match(r.stderr, /FATAL: post-forward reverse sync failed/);
  });

  test("post-forward drift retries forward once and passes when the board converges", async () => {
    const r = await run({
      plan: { "sync.mjs": [{}, {}, { write: { [CARD]: drifted } }, {}, { write: { [CARD]: card({ id: "S-1", status: "Backlog" }) } }] },
    });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /After forward sync, the GitHub Project board still differs/);
    assert.match(r.stdout, /Post-forward drift detected — retrying forward sync once/);
    assert.match(r.stdout, /Post-forward verify passed after retry\./);
    assert.equal(stubCalls(r.stdout).length, 6);
  });

  test("forward retry failure is fatal", async () => {
    const r = await run({ plan: { "sync.mjs": [{}, {}, { write: { [CARD]: drifted } }, { exit: 7 }] } });
    assert.equal(r.status, 7);
    assert.match(r.stderr, /FATAL: forward retry failed/);
  });

  test("board still diverging after the retry is fatal", async () => {
    const r = await run({ plan: { "sync.mjs": [{}, {}, { write: { [CARD]: drifted } }] } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FATAL: board still diverges after forward retry/);
    assert.equal(readFile(r.ws, CARD), drifted);
  });

  test("--skip-post-verify skips step 4", async () => {
    const r = await run({ args: ["--skip-post-verify"] });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /Step 4\/4: skipped post-forward verify\n/);
  });

  test("--skip-board-guard skips the alignment check even when the board drifted", async () => {
    const r = await run({ args: ["--skip-board-guard"], plan: { "sync.mjs": [{ write: { [CARD]: drifted } }] } });
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.stdout, /Step 2b\/4/);
    assert.match(r.stdout, /skipped post-forward verify \(dry-run \/ skip-reverse \/ skip-guard\)/);
  });

  test("unexpected errors in main are reported as FATAL ERROR", async () => {
    const r = await run({ execArgv: ["--import", preload], env: { HYPERION_TEST_THROW_ON_LOG: "Step 1/4" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[ci-sync\] FATAL ERROR/);
    assert.match(r.stderr, /injected failure/);
  });
});
