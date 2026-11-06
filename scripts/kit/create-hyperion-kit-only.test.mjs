import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isKitOnly, productKitPackageJson, stripKitScripts } from "../hyperion/create-hyperion.mjs";
import { detectKit } from "../hyperion/distribution-purity-check.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const createScript = join(repoRoot, "scripts", "hyperion", "create-hyperion.mjs");

test("isKitOnly: scripts/kit and every non-hyperion-* workflow stay in the Hyperion repo", () => {
  assert.equal(isKitOnly("scripts/kit"), true);
  assert.equal(isKitOnly("scripts/kit/coverage.mjs"), true);
  assert.equal(isKitOnly("scripts\\kit\\coverage.mjs"), true);
  assert.equal(isKitOnly(".github/workflows/qa-release-gate.yml"), true);
  assert.equal(isKitOnly(".github/workflows/branch-flow.yml"), true);
  assert.equal(isKitOnly(".github/workflows/internal-sync.yml"), true);
  assert.equal(isKitOnly(".github/workflows/hyperion-validate.yml"), false);
  assert.equal(isKitOnly(".github/workflows"), false);
  assert.equal(isKitOnly("scripts/hyperion/templates/workflows/ci.yml"), false, "product templates ship");
  assert.equal(isKitOnly("scripts/kitchen.mjs"), false);
});

test("stripKitScripts drops only kit:* npm scripts", () => {
  const out = JSON.parse(stripKitScripts(JSON.stringify({ name: "x", scripts: { "kit:test": "a", "kit:coverage": "b", "hyperion:test": "c" } })));
  assert.deepEqual(out.scripts, { "hyperion:test": "c" });
  assert.equal(stripKitScripts('{"name":"x"}'), '{"name":"x"}');
});

test("productKitPackageJson renames the copy and drops the kit's repository links", () => {
  const kitPkg = JSON.stringify({
    name: "hyperion",
    repository: { type: "git", url: "https://github.com/MatheusFelipeCorrea/Hyperion.git" },
    bugs: { url: "https://github.com/MatheusFelipeCorrea/Hyperion/issues" },
    homepage: "https://github.com/MatheusFelipeCorrea/Hyperion",
    scripts: { "kit:test": "a", "hyperion:test": "b" },
  });
  const out = JSON.parse(productKitPackageJson(kitPkg, "My Product!"));
  assert.equal(out.name, "my-product-hyperion");
  assert.equal(out.repository, undefined);
  assert.equal(out.bugs, undefined);
  assert.equal(out.homepage, undefined);
  assert.deepEqual(out.scripts, { "hyperion:test": "b" });
  assert.equal(JSON.parse(productKitPackageJson(kitPkg, "...")).name, "product-hyperion");
});

test("a product scaffolded from this checkout gets none of the kit-only files", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-create-"));
  try {
    const product = join(dir, "acme");
    const r = spawnSync(process.execPath, [createScript, product, "--yes", "--from", repoRoot, "--skip-install", "--skip-adopt"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);

    const kit = join(product, "Hyperion");
    assert.ok(existsSync(join(kit, "scripts", "hyperion", "create-hyperion.mjs")), "the kit itself is copied");
    assert.ok(!existsSync(join(kit, "scripts", "kit")), "scripts/kit must not reach a product");

    const workflows = readdirSync(join(kit, ".github", "workflows"));
    assert.ok(workflows.length > 0);
    assert.deepEqual(workflows.filter((f) => !f.startsWith("hyperion-")), [], "only hyperion-* workflows are copied");

    const scripts = JSON.parse(readFileSync(join(kit, "package.json"), "utf8")).scripts;
    assert.deepEqual(Object.keys(scripts).filter((s) => s.startsWith("kit:")), []);
    assert.ok(scripts["hyperion:test"], "the product's kit scripts are kept");
    assert.equal(detectKit(kit).isKit, false, "the nested kit must not look like the Hyperion repo to the purity check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
