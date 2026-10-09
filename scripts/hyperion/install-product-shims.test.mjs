import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupTmp, makeTmp, relocateEnv, runNodeAsync, writeFiles } from "./test-support/cli-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

/**
 * Build a throwaway "product/Hyperion/" tree with a real, working copy of
 * scripts/hyperion + scripts/cards-sync + .github (so relative imports and
 * resolveHyperionPaths() resolve for real, not a stub).
 */
function makeProductFixture() {
  const productDir = mkdtempSync(join(tmpdir(), "install-shims-product-"));
  const kitDir = join(productDir, "Hyperion");
  mkdirSync(kitDir, { recursive: true });
  cpSync(join(repoRoot, "scripts"), join(kitDir, "scripts"), { recursive: true });
  cpSync(join(repoRoot, ".github"), join(kitDir, ".github"), { recursive: true });
  return { productDir, kitDir };
}

describe("install-product-shims", () => {
  it("writes shims at the product root when run with cwd = product root", () => {
    const { productDir, kitDir } = makeProductFixture();
    try {
      const script = join(kitDir, "scripts", "hyperion", "install-product-shims.mjs");
      const r = spawnSync(process.execPath, [script], { cwd: productDir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.ok(existsSync(join(productDir, "CLAUDE.md")), "CLAUDE.md shim should exist at product root");
      assert.ok(
        existsSync(join(productDir, ".github", "project.yml")),
        "project.yml should exist at product root"
      );
      const yml = readFileSync(join(productDir, ".github", "project.yml"), "utf8");
      assert.match(yml, /kit:\s*\n\s*root:\s*Hyperion/);
    } finally {
      rmSync(productDir, { recursive: true, force: true });
    }
  });

  it("writes shims at the product root even with cwd = Hyperion/ (regression: npm run ... --prefix Hyperion -- --adopt)", () => {
    // This is the exact documented onboarding command from README/GETTING-STARTED:
    // `npm run hyperion:init --prefix Hyperion -- --adopt`. npm's --prefix sets the
    // spawned script's own cwd to the prefix dir — previously this made the script
    // (which read process.cwd() as the product root) look for
    // Hyperion/Hyperion/.github/cards and fail 100% of the time.
    const { productDir, kitDir } = makeProductFixture();
    try {
      const script = join(kitDir, "scripts", "hyperion", "install-product-shims.mjs");
      const r = spawnSync(process.execPath, [script], { cwd: kitDir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.ok(
        !r.stdout.includes("copy the Hyperion folder first"),
        "should not report the nested-kit-not-found error"
      );
      assert.ok(
        existsSync(join(productDir, "CLAUDE.md")),
        "CLAUDE.md shim should land at the PRODUCT root, not inside Hyperion/"
      );
      assert.ok(
        !existsSync(join(kitDir, "CLAUDE.md")),
        "CLAUDE.md shim should NOT land inside Hyperion/ itself"
      );
      assert.ok(existsSync(join(productDir, ".github", "project.yml")));
    } finally {
      rmSync(productDir, { recursive: true, force: true });
    }
  });

  it("fails clearly (not a crash) when the kit folder has no .github/cards", () => {
    // Kit root is derived from the script's own file location, not cwd, so this
    // fixture must still be named "Hyperion" (the default --kit name) — just
    // without .github/cards, to exercise the "copy the kit folder first" guard.
    const productDir = mkdtempSync(join(tmpdir(), "install-shims-bare-"));
    const bareKitDir = join(productDir, "Hyperion");
    mkdirSync(join(bareKitDir, "scripts", "hyperion"), { recursive: true });
    cpSync(join(repoRoot, "scripts", "hyperion"), join(bareKitDir, "scripts", "hyperion"), {
      recursive: true,
    });
    cpSync(join(repoRoot, "scripts", "cards-sync"), join(bareKitDir, "scripts", "cards-sync"), {
      recursive: true,
    });
    try {
      const script = join(bareKitDir, "scripts", "hyperion", "install-product-shims.mjs");
      const r = spawnSync(process.execPath, [script], { cwd: productDir, encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /copy the Hyperion folder first/);
    } finally {
      rmSync(productDir, { recursive: true, force: true });
    }
  });
});

// The script derives the product root from its own location, so these runs relocate
// this checkout's copy into a temp product (see test-support/relocate-preload.mjs):
// coverage is attributed to the real file and nothing is written next to the repo.
describe("install-product-shims (relocated into a temp product)", { concurrency: true }, () => {
  after(cleanupTmp);
  const real = join(__dirname, "install-product-shims.mjs");

  function product(files = {}, kit = "Kit") {
    const dir = makeTmp("install-shims-");
    writeFiles(dir, { [`${kit}/.github/cards/.gitkeep`]: "", ...files });
    return dir;
  }

  function shims(dir, args = [], kit = "Kit") {
    const to = join(dir, kit, "scripts", "hyperion", "install-product-shims.mjs");
    return runNodeAsync(real, kit === "Hyperion" ? args : ["--kit", kit, ...args], { cwd: dir, env: relocateEnv(real, to) });
  }

  const read = (dir, rel) => readFileSync(join(dir, ...rel.split("/")), "utf8");

  it("fails when the kit folder has no .github/cards", async () => {
    const dir = makeTmp("install-shims-bare-");
    const r = await shims(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Expected Kit\/\.github\/cards/);
    assert.ok(!existsSync(join(dir, "CLAUDE.md")));
  });

  it("without project.example.yml writes a minimal project.yml with kit.root plus both shims", async () => {
    const dir = product();
    const r = await shims(dir);
    assert.equal(r.status, 0, r.out);
    assert.match(read(dir, ".github/project.yml"), /^version: 1\n\nkit:\n  root: Kit\n/);
    assert.match(read(dir, "CLAUDE.md"), /Hyperion kit in `\.\/Kit\/`/);
    assert.match(read(dir, ".cursor/rules/hyperion.mdc"), /nested under Kit\//);
    assert.match(r.stdout, /layout=nested cardsPrefix=Kit\/\.github\/cards/);
  });

  it("prepends kit.root when the example has no version line", async () => {
    const dir = product({ "Kit/.github/project.example.yml": "name: Example\n" });
    assert.equal((await shims(dir)).status, 0);
    assert.equal(read(dir, ".github/project.yml"), "version: 1\nkit:\n  root: Kit\n\nname: Example\n");
  });

  it("fills an empty kit: block from the example and keeps a complete one as-is", async () => {
    const empty = product({ "Kit/.github/project.example.yml": "version: 1\nkit:\nname: X\n" });
    assert.equal((await shims(empty)).status, 0);
    assert.match(read(empty, ".github/project.yml"), /kit:\n  root: Kit\nname: X/);

    const full = product({ "Kit/.github/project.example.yml": "version: 1\nkit:\n  root: Elsewhere\n" });
    assert.equal((await shims(full)).status, 0);
    assert.equal(read(full, ".github/project.yml"), "version: 1\nkit:\n  root: Elsewhere\n");
  });

  it("adds kit.root to an existing project.yml and leaves one that already has kit: alone", async () => {
    const dir = product({ ".github/project.yml": "version: 2\nname: App\n" });
    const r = await shims(dir);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Added kit\.root/);
    assert.equal(read(dir, ".github/project.yml"), "version: 2\n\nkit:\n  root: Kit\n\nname: App\n");

    const again = await shims(dir);
    assert.match(again.stdout, /already has kit:/);
    assert.match(again.stdout, /Skip existing CLAUDE\.md shim/);
    assert.match(again.stdout, /Skip existing Cursor rules shim/);
  });

  it("an existing project.yml without a version line only gets kit.root with --force", async () => {
    const dir = product({ ".github/project.yml": "name: App\n", "CLAUDE.md": "# mine\n" });
    let r = await shims(dir);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /Added kit\.root/);
    assert.match(r.stdout, /no version: line — kit\.root not added \(re-run with --force/);
    assert.equal(read(dir, ".github/project.yml"), "name: App\n");
    assert.equal(read(dir, "CLAUDE.md"), "# mine\n");

    r = await shims(dir, ["--force"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Added kit\.root/);
    assert.equal(read(dir, ".github/project.yml"), "kit:\n  root: Kit\n\nname: App\n");
    assert.match(read(dir, "CLAUDE.md"), /Hyperion \(shim\)/, "--force overwrites the CLAUDE.md shim");

    r = await shims(dir, ["--force"]);
    assert.match(r.stdout, /already has kit:/, "--force is idempotent once kit: exists");
    assert.equal(read(dir, ".github/project.yml"), "kit:\n  root: Kit\n\nname: App\n");
  });

  it("defaults the kit folder to Hyperion/", async () => {
    const dir = product({}, "Hyperion");
    const r = await shims(dir, [], "Hyperion");
    assert.equal(r.status, 0, r.out);
    assert.match(read(dir, ".github/project.yml"), /root: Hyperion/);
  });

  it("reports unexpected errors and exits 1", async () => {
    const dir = product();
    mkdirSync(join(dir, ".github", "project.yml"), { recursive: true });
    const r = await shims(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /EISDIR|illegal operation/i);
  });
});
