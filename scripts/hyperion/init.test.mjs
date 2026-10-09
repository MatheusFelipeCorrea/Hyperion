import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTmp,
  FAULT_SPAWN,
  hyperionDir,
  kitWorkspace,
  makeBin,
  makeTmp,
  relocateEnv,
  runNodeAsync,
  writeFiles,
} from "./test-support/cli-harness.mjs";

const init = join(hyperionDir, "init.mjs");
const cursorRules = join(hyperionDir, "install-cursor-rules.mjs");
const ghFail = makeBin({ gh: "fail" });

after(cleanupTmp);

const run = (cwd, args = [], env = {}, opts = {}) => runNodeAsync(init, args, { cwd, env, binDir: ghFail, ...opts });

describe("init.mjs", { concurrency: true }, () => {
  it("--adopt runs install-product-shims (with --force under --yes) for a nested kit", async () => {
    const product = writeFiles(makeTmp("init-adopt-"), { "Hyperion/.github/cards/.gitkeep": "", "CLAUDE.md": "# old\n" });
    const shims = join(hyperionDir, "install-product-shims.mjs");
    // The shims script derives the product root from its own path: relocate it into the temp product.
    const env = relocateEnv(shims, join(product, "Hyperion", "scripts", "hyperion", "install-product-shims.mjs"));
    const r = await run(product, ["--adopt", "--yes"], env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /adopt nested kit/);
    assert.match(readFileSync(join(product, "CLAUDE.md"), "utf8"), /Hyperion \(shim\)/);
    assert.match(readFileSync(join(product, ".github", "project.yml"), "utf8"), /root: Hyperion/);
  });

  it("stops on blockers", async () => {
    const r = await run(makeTmp("init-empty-"));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Fix blockers above, then re-run: npm run hyperion:init/);
  });

  it("reports unexpected errors and exits 1", async () => {
    const r = await run(kitWorkspace(), [], { PROJECT_SYNC_TOKEN: "test-token" }, { nodeArgs: FAULT_SPAWN });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /❌ injected spawnSync failure/);
  });
});

describe("install-cursor-rules.mjs", { concurrency: true }, () => {
  it("reports when the rules template is missing, keeps an existing one, and fails on unreadable rules", async () => {
    const missing = await runNodeAsync(cursorRules, [], { cwd: makeTmp("cursor-") });
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /No hyperion\.mdc template found/);

    const cwd = writeFiles(makeTmp("cursor-"), { ".cursor/rules/hyperion.mdc": "rules\n" });
    const same = await runNodeAsync(cursorRules, [], { cwd });
    assert.equal(same.status, 0);
    assert.match(same.stdout, /already up to date/);
    assert.equal(readFileSync(join(cwd, ".cursor", "rules", "hyperion.mdc"), "utf8"), "rules\n");

    const broken = makeTmp("cursor-");
    mkdirSync(join(broken, ".cursor", "rules", "hyperion.mdc"), { recursive: true });
    const r = await runNodeAsync(cursorRules, [], { cwd: broken });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[Hyperion\] FATAL:/);
    assert.ok(existsSync(join(broken, ".cursor", "rules", "hyperion.mdc")));
  });
});
