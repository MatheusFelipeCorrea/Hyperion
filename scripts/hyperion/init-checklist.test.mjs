import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cleanupTmp, faultEnv, hyperionDir, kitWorkspace, linearEnv, makeBin, runNodeAsync } from "./test-support/cli-harness.mjs";

// The full init checklist spawns repo-detect, cursor rules, doctor (+ cards doctor)
// and optionally setup — kept apart from init.test.mjs to stay well under 30s per file.
const init = join(hyperionDir, "init.mjs");
const ghFail = makeBin({ gh: "fail" });

after(cleanupTmp);

describe("init.mjs checklist", { concurrency: true }, () => {
  it("runs repo-detect, cursor rules and doctor, then suggests /setup or /migrate", async () => {
    const cwd = kitWorkspace({ ".github/project.yml": null, ".cursor/rules/hyperion.mdc": null });
    const r = await runNodeAsync(init, [], { cwd, binDir: ghFail, env: linearEnv() });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Kit layout looks healthy/);
    assert.match(r.stdout, /No hyperion\.mdc template found/);
    assert.match(r.stdout, /Cursor rules skipped/);
    assert.match(r.stdout, /Existing code\? Ask in chat: \/migrate/);
    assert.match(r.stdout, /hyperion:init complete/);
  });

  it("--setup chains into setup.mjs and propagates its exit code; doctor failures only warn", async () => {
    const cwd = kitWorkspace({}, { backend: "azure" });
    // setup.mjs itself is covered by setup.test.mjs: here it fails fast (exit 1) so only the chaining is exercised.
    const env = { GITHUB_REPOSITORY: "acme/app", PROJECT_SYNC_TOKEN: "test-token", ...faultEnv("setup.mjs") };
    const r = await runNodeAsync(init, ["--setup", "--yes"], { cwd, binDir: ghFail, env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /Cursor rules already up to date/);
    assert.match(r.stdout, /Doctor reported issues — see output above/);
    assert.match(r.stdout, /Ask: \/doctor {2}then {2}\/refine/);
    assert.match(r.stdout, /Running hyperion:setup/);
    assert.match(r.stdout, /FATAL: injected spawnSync failure/);
  });
});
