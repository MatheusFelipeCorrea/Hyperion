import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildUpgradePlan,
  applyUpgradePlan,
  mergePackageJson,
  mergeGitignore,
  isPreserved,
  summarizePlan,
  recordUpgradeChangelog,
} from "./upgrade-lib.mjs";
import { sameCommit, resolveOrigin, DEFAULT_ORIGIN } from "./upgrade-fetch.mjs";

function makeKit(root) {
  mkdirSync(join(root, "scripts", "hyperion"), { recursive: true });
  mkdirSync(join(root, "scripts", "cards-sync"), { recursive: true });
  mkdirSync(join(root, ".github", "skills", "setup", "x"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "scripts", "hyperion", "doctor.mjs"), "export const v = 2;\n");
  writeFileSync(join(root, "scripts", "cards-sync", "sync.mjs"), "export const sync = 2;\n");
  writeFileSync(join(root, ".github", "skills", "setup", "x", "SKILL.md"), "# skill v2\n");
  writeFileSync(join(root, ".github", "commands.yml"), "version: 2\n");
  writeFileSync(join(root, ".github", "workflows", "hyperion-validate.yml"), "name: hv2\n");
  writeFileSync(join(root, ".github", "workflows", "product.yml"), "name: product-should-not-copy\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.github/plans/cards/sync-history.jsonl\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "hyperion",
        scripts: {
          "hyperion:doctor": "node scripts/hyperion/doctor.mjs",
          "hyperion:upgrade": "node scripts/hyperion/upgrade.mjs",
          "my-product": "echo no",
        },
        engines: { node: ">=20" },
      },
      null,
      2
    )
  );
}

function makeClient(root) {
  mkdirSync(join(root, "scripts", "hyperion"), { recursive: true });
  mkdirSync(join(root, ".github", "memory"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "scripts", "hyperion", "doctor.mjs"), "export const v = 1;\n");
  writeFileSync(join(root, ".github", "project.yml"), "name: client\n");
  writeFileSync(join(root, ".github", "memory", "PROJECT.md"), "# mem\n");
  writeFileSync(join(root, ".github", "workflows", "product.yml"), "name: keep-me\n");
  writeFileSync(join(root, ".gitignore"), "dist/\n.env.local\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "acme-app",
        scripts: {
          start: "node app.js",
          "hyperion:doctor": "node scripts/hyperion/doctor.mjs",
        },
      },
      null,
      2
    )
  );
}

describe("upgrade-lib", () => {
  it("preserves project.yml and memory", () => {
    assert.equal(isPreserved(".github/project.yml"), true);
    assert.equal(isPreserved(".github/memory/PROJECT.md"), true);
    assert.equal(isPreserved(".github/skills/x/SKILL.md"), false);
  });

  it("mergePackageJson keeps product scripts and adds kit scripts", () => {
    const merged = mergePackageJson(
      { name: "app", scripts: { start: "node .", "hyperion:doctor": "old" } },
      {
        scripts: {
          "hyperion:doctor": "new",
          "hyperion:upgrade": "up",
          "cards:sync": "sync",
        },
        engines: { node: ">=20" },
      }
    );
    assert.equal(merged.scripts.start, "node .");
    assert.equal(merged.scripts["hyperion:doctor"], "new");
    assert.equal(merged.scripts["hyperion:upgrade"], "up");
    assert.equal(merged.engines.node, ">=20");
  });

  it("mergeGitignore appends kit block without touching product's own lines", () => {
    const merged = mergeGitignore("dist/\n.env.local\n", "node_modules/\n.env\n");
    assert.match(merged, /dist\//);
    assert.match(merged, /\.env\.local/);
    assert.match(merged, /node_modules\//);
    assert.match(merged, /Hyperion kit/);
  });

  it("mergeGitignore re-run replaces only the kit block, keeps product lines and is idempotent", () => {
    const once = mergeGitignore("dist/\n", "node_modules/\n");
    const twice = mergeGitignore(once, "node_modules/\n.env\n");
    assert.match(twice, /dist\//);
    assert.match(twice, /node_modules\//);
    assert.match(twice, /\.env\b/);
    assert.equal((twice.match(/dist\//g) || []).length, 1);
    assert.equal(mergeGitignore(twice, "node_modules/\n.env\n"), twice);
  });

  it("mergeGitignore creates the file from scratch when the client has none", () => {
    const merged = mergeGitignore("", "node_modules/\n");
    assert.match(merged, /node_modules\//);
  });

  it("plans updates and preserves client files", async () => {
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    const client = mkdtempSync(join(tmpdir(), "client-"));
    try {
      makeKit(kit);
      makeClient(client);
      const plan = await buildUpgradePlan(kit, client);
      const byRel = Object.fromEntries(plan.map((p) => [p.rel, p]));
      assert.equal(byRel["scripts/hyperion/doctor.mjs"].action, "update");
      assert.equal(byRel[".github/skills/setup/x/SKILL.md"].action, "add");
      assert.equal(byRel[".github/workflows/hyperion-validate.yml"].action, "add");
      assert.ok(!byRel[".github/workflows/product.yml"]);
      assert.equal(byRel["package.json"].action, "update");
      assert.equal(byRel[".gitignore"].action, "update");
      const counts = summarizePlan(plan);
      assert.ok(counts.update >= 1);
      assert.ok(counts.add >= 1);
    } finally {
      rmSync(kit, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });

  it("applies upgrade without touching project.yml", async () => {
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    const client = mkdtempSync(join(tmpdir(), "client-"));
    try {
      makeKit(kit);
      makeClient(client);
      const plan = await buildUpgradePlan(kit, client);
      await applyUpgradePlan(kit, client, plan, { yes: true });
      assert.equal(readFileSync(join(client, ".github", "project.yml"), "utf8"), "name: client\n");
      assert.equal(readFileSync(join(client, ".github", "memory", "PROJECT.md"), "utf8"), "# mem\n");
      assert.match(readFileSync(join(client, "scripts", "hyperion", "doctor.mjs"), "utf8"), /v = 2/);
      assert.match(
        readFileSync(join(client, ".github", "workflows", "hyperion-validate.yml"), "utf8"),
        /hv2/
      );
      assert.match(
        readFileSync(join(client, ".github", "workflows", "product.yml"), "utf8"),
        /keep-me/
      );
      const pkg = JSON.parse(readFileSync(join(client, "package.json"), "utf8"));
      assert.equal(pkg.name, "acme-app");
      assert.equal(pkg.scripts.start, "node app.js");
      assert.equal(pkg.scripts["hyperion:upgrade"], "node scripts/hyperion/upgrade.mjs");
      const gitignore = readFileSync(join(client, ".gitignore"), "utf8");
      assert.match(gitignore, /dist\//, "product's own ignore line must survive the merge");
      assert.match(gitignore, /node_modules\//, "kit's ignore line must be added");
      assert.match(gitignore, /sync-history\.jsonl/, "kit's ignore line must be added");
      const meta = JSON.parse(readFileSync(join(client, ".github", "hyperion-kit.json"), "utf8"));
      assert.ok(meta.upgraded_at);
      assert.match(readFileSync(join(client, "CHANGELOG.md"), "utf8"), /Hyperion kit upgrade/);
    } finally {
      rmSync(kit, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });
});

describe("upgrade-fetch", () => {
  it("sameCommit matches short and long shas", () => {
    assert.equal(
      sameCommit("abc1234def", "abc1234def999999999999999999999999999999"),
      true
    );
    assert.equal(sameCommit("abc1234", "zzz1234"), false);
  });

  it("resolveOrigin reads hyperion-origin.json and overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "origin-"));
    try {
      mkdirSync(join(dir, ".github"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "hyperion-origin.json"),
        JSON.stringify({ repo: "acme/Hyperion", ref: "develop" })
      );
      const o = await resolveOrigin(dir, {});
      assert.equal(o.repo, "acme/Hyperion");
      assert.equal(o.ref, "develop");
      const over = await resolveOrigin(dir, { repo: "other/Kit", ref: "v1" });
      assert.equal(over.repo, "other/Kit");
      assert.equal(over.ref, "v1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEFAULT_ORIGIN points at known kit repo", () => {
    assert.match(DEFAULT_ORIGIN.repo, /\//);
    assert.ok(DEFAULT_ORIGIN.ref);
  });
});
