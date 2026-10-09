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
  repoRoot,
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
  const kitRules = readFileSync(join(repoRoot, ".cursor", "rules", "hyperion.mdc"), "utf8");
  const rulesIn = (dir) => join(dir, ".cursor", "rules", "hyperion.mdc");

  /** Run the real script as if it lived in `<kitDir>/scripts/hyperion/`. */
  const runFromKit = (kitDir, cwd) =>
    runNodeAsync(cursorRules, [], { cwd, env: relocateEnv(cursorRules, join(kitDir, "scripts", "hyperion", "install-cursor-rules.mjs")) });

  it("installs the kit's rules into the product's .cursor/rules, then is a no-op", async () => {
    const cwd = makeTmp("cursor-");
    const first = await runNodeAsync(cursorRules, [], { cwd });
    assert.equal(first.status, 0, first.out);
    assert.match(first.stdout, /Installed \.cursor\/rules\/hyperion\.mdc/);
    assert.equal(readFileSync(rulesIn(cwd), "utf8"), kitRules);

    const again = await runNodeAsync(cursorRules, [], { cwd });
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, /already up to date/);
    assert.equal(readFileSync(rulesIn(cwd), "utf8"), kitRules);
  });

  it("updates outdated product rules to the kit's copy", async () => {
    const cwd = writeFiles(makeTmp("cursor-"), { ".cursor/rules/hyperion.mdc": "old rules\n" });
    const r = await runNodeAsync(cursorRules, [], { cwd });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Updated \.cursor\/rules\/hyperion\.mdc/);
    assert.equal(readFileSync(rulesIn(cwd), "utf8"), kitRules);
  });

  it("is a no-op when run from the kit root itself (legacy layout)", async () => {
    const kit = writeFiles(makeTmp("cursor-kit-"), { ".cursor/rules/hyperion.mdc": "kit rules\n" });
    const r = await runFromKit(kit, kit);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /already up to date/);
    assert.equal(readFileSync(rulesIn(kit), "utf8"), "kit rules\n");
  });

  it("leaves the product shim alone for a kit nested under the cwd", async () => {
    const product = writeFiles(makeTmp("cursor-product-"), {
      "Hyperion/.cursor/rules/hyperion.mdc": "kit rules\n",
      ".cursor/rules/hyperion.mdc": "shim\n",
    });
    const r = await runFromKit(join(product, "Hyperion"), product);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Nested kit \(Hyperion\/\): product rules come from the shim/);
    assert.equal(readFileSync(rulesIn(product), "utf8"), "shim\n");
  });

  it("fails when the kit has no rules template, writing nothing", async () => {
    const kit = makeTmp("cursor-kit-");
    const cwd = makeTmp("cursor-");
    const r = await runFromKit(kit, cwd);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /No hyperion\.mdc template found in the kit/);
    assert.equal(existsSync(join(cwd, ".cursor")), false);
  });

  it("reports unwritable targets as FATAL", async () => {
    const broken = makeTmp("cursor-");
    mkdirSync(rulesIn(broken), { recursive: true });
    const r = await runNodeAsync(cursorRules, [], { cwd: broken });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[Hyperion\] FATAL:/);
    assert.ok(existsSync(rulesIn(broken)));
  });
});
