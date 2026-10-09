import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, gitCommitAll, githubToLocalEnv, hyperionDir, makeBin, makeTmp, runNodeAsync, writeFiles } from "./test-support/cli-harness.mjs";

const create = join(hyperionDir, "create-hyperion.mjs");

/** A tiny kit tree, including the runtime dirs/files create-hyperion must skip. */
function miniKit({ shims = null } = {}) {
  return writeFiles(makeTmp("create-kit-"), {
    "scripts/hyperion/doctor.mjs": "export const v = 1;\n",
    ".github/project.example.yml": "version: 1\n",
    ".github/project.yml": "name: this-kit-only\n",
    ".github/plans/session.md": "private\n",
    ".github/audits/results/round.md": "private\n",
    ".github/audits/README.md": "kept\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    "node_modules/dep/index.js": "x\n",
    "nested/node_modules/x.js": "x\n",
    ...(shims ? { "scripts/hyperion/install-product-shims.mjs": shims } : {}),
  });
}

const KIT_FILES = 3; // doctor.mjs, project.example.yml, audits/README.md

after(cleanupTmp);

describe("create-hyperion.mjs arguments", { concurrency: true }, () => {
  it("--help exits 0; no target prints usage and exits 1", async () => {
    const cwd = makeTmp();
    const help = await runNodeAsync(create, ["-h"], { cwd });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--skip-adopt/);
    const none = await runNodeAsync(create, [], { cwd });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /create-hyperion — scaffold/);
  });

  it("refuses a non-empty nested kit folder unless --force", async () => {
    const cwd = writeFiles(makeTmp(), { "app/Hyperion/keep.txt": "x\n" });
    const kit = miniKit();
    let r = await runNodeAsync(create, ["app", "--from", kit], { cwd });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /already exists and isn't empty/);

    r = await runNodeAsync(create, ["app", "--from", kit, "--force"], { cwd });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Mode: DRY-RUN/);
  });

  it("an existing but empty nested folder is fine", async () => {
    const cwd = makeTmp();
    mkdirSync(join(cwd, "app", "Hyperion"), { recursive: true });
    const r = await runNodeAsync(create, ["app", "--from", miniKit(), "--kit-name", "Hyperion"], { cwd });
    assert.equal(r.status, 0, r.out);
  });

  it("rejects --from that is not a kit", async () => {
    const r = await runNodeAsync(create, ["app", "--from", makeTmp("not-kit-")], { cwd: makeTmp() });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Not a Hyperion kit/);
  });
});

describe("create-hyperion.mjs local scaffold", { concurrency: true }, () => {
  it("dry-run counts files without the skipped runtime dirs and writes nothing", async () => {
    const cwd = makeTmp();
    const r = await runNodeAsync(create, ["app", "--from", miniKit(), "--kit-name", "Kit"], { cwd });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`Would copy ~${KIT_FILES} file\\(s\\)`));
    assert.match(r.stdout, /Nested kit folder: Kit\//);
    assert.equal(existsSync(join(cwd, "app")), false);
  });

  it("dry-run from this checkout (default source) succeeds", async () => {
    const r = await runNodeAsync(create, ["app"], { cwd: makeTmp() });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Source: local checkout/);
  });

  it("--yes --skip-install --skip-adopt copies the kit minus runtime/output paths", async () => {
    const cwd = makeTmp();
    const r = await runNodeAsync(create, ["app", "--yes", "--from", miniKit(), "--skip-install", "--skip-adopt"], { cwd });
    assert.equal(r.status, 0, r.out);
    const kit = join(cwd, "app", "Hyperion");
    assert.match(r.stdout, new RegExp(`Copied ${KIT_FILES} file\\(s\\)`));
    assert.ok(existsSync(join(kit, "scripts", "hyperion", "doctor.mjs")));
    assert.ok(existsSync(join(kit, ".github", "audits", "README.md")));
    for (const skipped of [".github/project.yml", ".github/plans", ".github/audits/results", ".git", "node_modules", "nested/node_modules"]) {
      assert.equal(existsSync(join(kit, ...skipped.split("/"))), false, `${skipped} must not be copied`);
    }
    assert.match(r.stdout, /Skipped npm install/);
    assert.match(r.stdout, /Skipped adopt shims/);
    assert.match(r.stdout, /cd app/);
  });

  it("runs npm install and the copied shims script when not skipped", async () => {
    const cwd = makeTmp();
    const kit = miniKit({ shims: "console.log('shims ran in ' + process.cwd());\n" });
    const r = await runNodeAsync(create, ["app", "-y", "--from", kit], { cwd, binDir: makeBin({ npm: 0 }) });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /npm install complete/);
    assert.ok(r.stdout.includes(`shims ran in ${join(cwd, "app")}`), r.stdout);
    assert.match(r.stdout, /create-hyperion complete/);
  });

  it("warns (but completes) when npm install or the shims script fail", async () => {
    const cwd = makeTmp();
    const r = await runNodeAsync(create, [".", "--yes", "--from", miniKit()], { cwd, binDir: makeBin({ npm: 1 }) });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /npm install failed/);
    assert.match(r.stdout, /install-product-shims\.mjs failed/);
    assert.match(r.stdout, /cd \./);
  });
});

describe("create-hyperion.mjs --repo", { concurrency: true }, () => {
  let remotes;
  let sha;
  let ghFail;

  before(() => {
    remotes = makeTmp("create-remotes-");
    sha = gitCommitAll(writeFiles(join(remotes, "acme", "kit.git"), { "scripts/hyperion/doctor.mjs": "export const v = 2;\n" }));
    ghFail = makeBin({ gh: "fail" });
  });

  it("fetches the kit from GitHub and scaffolds from the clone", async () => {
    const cwd = makeTmp();
    const r = await runNodeAsync(create, ["app", "--yes", "--repo", "acme/kit", "--ref", "main", "--skip-install", "--skip-adopt"], {
      cwd,
      binDir: ghFail,
      env: githubToLocalEnv(remotes),
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`Source: github\\.com/acme/kit@main \\(${sha.slice(0, 12)}\\)`));
    assert.match(readFileSync(join(cwd, "app", "Hyperion", "scripts", "hyperion", "doctor.mjs"), "utf8"), /v = 2/);
    assert.equal(existsSync(join(cwd, "app", "Hyperion", ".git")), false);
  });

  it("fails cleanly when the repo can't be resolved", async () => {
    const r = await runNodeAsync(create, ["app", "--repo", "acme/missing"], { cwd: makeTmp(), binDir: ghFail, env: githubToLocalEnv(remotes) });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Could not resolve acme\/missing@main/);
  });
});
