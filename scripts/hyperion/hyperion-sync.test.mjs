import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cleanupTmp, FAULT_SPAWN, hyperionDir, kitWorkspace, linearEnv, makeBin, makeTmp, runNodeAsync } from "./test-support/cli-harness.mjs";

// scripts/hyperion/sync.mjs — the validate-then-sync wrapper (not cards-sync/sync.mjs).
const sync = join(hyperionDir, "sync.mjs");
const ghFail = makeBin({ gh: "fail" });

after(cleanupTmp);

const run = (cwd, args = [], env = {}, opts = {}) => runNodeAsync(sync, args, { cwd, env, binDir: ghFail, ...opts });

describe("hyperion sync.mjs", { concurrency: true }, () => {
  it("stops on blockers", async () => {
    const r = await run(makeTmp("sync-empty-"));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /❌ Missing `\.github\/`/);
  });

  it("stops when cards fail validation", async () => {
    const cwd = kitWorkspace({ ".github/cards/stories/BAD-1.md": "---\ncard_id: BAD-1\ntitle: Bad\ntype: Bogus\n---\n\n# Bad\n" });
    const r = await run(cwd, [], linearEnv());
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /type "Bogus" is not allowed/);
    assert.doesNotMatch(r.stdout, /complete\./);
  });

  it("without a token forces a dry-run", async () => {
    const r = await run(kitWorkspace(), [], linearEnv({ token: false }));
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /No GitHub token — running dry-run only/);
    assert.match(r.stdout, /sync\.mjs --dry-run/);
    assert.match(r.stdout, /Dry-run complete\./);
  });

  it("with a token syncs for real (or dry-runs on request)", async () => {
    const cwd = kitWorkspace();
    const real = await run(cwd, [], linearEnv());
    assert.equal(real.status, 0, real.out);
    assert.match(real.stdout, /Sync complete\./);
    const dry = await run(cwd, ["--dry-run"], linearEnv());
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.stdout, /Dry-run complete\./);
  });

  it("propagates a failing cards sync", async () => {
    const r = await run(kitWorkspace({}, { backend: "azure" }), [], { GITHUB_REPOSITORY: "acme/app", PROJECT_SYNC_TOKEN: "test-token" });
    assert.notEqual(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /Sync complete\./);
  });

  it("reports unexpected errors as FATAL", async () => {
    const r = await run(kitWorkspace(), [], { PROJECT_SYNC_TOKEN: "test-token" }, { nodeArgs: FAULT_SPAWN });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FATAL: injected spawnSync failure/);
  });
});
