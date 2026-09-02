import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
