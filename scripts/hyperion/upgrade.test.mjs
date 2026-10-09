import { after, describe, it } from "node:test";
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
import { cleanupTmp, gitCommitAll } from "./test-support/cli-harness.mjs";
import {
  buildUpgradePlan,
  applyUpgradePlan,
  mergePackageJson,
  mergeGitignore,
  isPreserved,
  summarizePlan,
  recordUpgradeChangelog,
  MANAGED_FILES,
  UPGRADE_BACKUP_DIR,
} from "./upgrade-lib.mjs";
import { sameCommit, resolveOrigin, DEFAULT_ORIGIN } from "./upgrade-fetch.mjs";

after(cleanupTmp);

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

  it("backs up a locally-modified managed file before overwriting it, and never backs up a brand-new add", async () => {
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    const client = mkdtempSync(join(tmpdir(), "client-"));
    try {
      makeKit(kit);
      makeClient(client);
      // makeClient already ships doctor.mjs with different content than
      // makeKit's ("v = 1" vs "v = 2") — the real-world "adopter modified a
      // shipped file" scenario this backup exists to protect.
      const plan = await buildUpgradePlan(kit, client);
      const { backedUp } = await applyUpgradePlan(kit, client, plan, { yes: true });

      const doctorBackup = backedUp.find((b) => b.rel === "scripts/hyperion/doctor.mjs");
      assert.ok(doctorBackup, "the modified doctor.mjs must be recorded as backed up");
      assert.equal(
        readFileSync(join(client, doctorBackup.backup), "utf8"),
        "export const v = 1;\n",
        "the backup must hold the client's PRE-overwrite content, not the kit's"
      );
      assert.equal(
        readFileSync(join(client, "scripts", "hyperion", "doctor.mjs"), "utf8"),
        "export const v = 2;\n",
        "the live file still gets the kit's new content — this is backup, not preserve"
      );
      assert.ok(
        doctorBackup.backup.startsWith(`${UPGRADE_BACKUP_DIR}/`),
        "backup path must live under the gitignored backup dir"
      );

      // .github/skills/setup/x/SKILL.md is a first-time "add" for this
      // client (doesn't exist yet) — nothing to lose, so no backup entry.
      const skillBackup = backedUp.find((b) => b.rel === ".github/skills/setup/x/SKILL.md");
      assert.equal(skillBackup, undefined, "a first-time add must never be backed up");
    } finally {
      rmSync(kit, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });

  it("never backs up or touches a custom file the adopter added under a managed dir", async () => {
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    const client = mkdtempSync(join(tmpdir(), "client-"));
    try {
      makeKit(kit);
      makeClient(client);
      mkdirSync(join(client, ".github", "skills", "custom", "my-skill"), { recursive: true });
      writeFileSync(
        join(client, ".github", "skills", "custom", "my-skill", "SKILL.md"),
        "# our own custom skill\n"
      );

      const plan = await buildUpgradePlan(kit, client);
      assert.ok(
        !plan.some((p) => p.rel === ".github/skills/custom/my-skill/SKILL.md"),
        "a skill that doesn't exist in the kit's own tree must never appear in the plan"
      );

      const { backedUp } = await applyUpgradePlan(kit, client, plan, { yes: true });
      assert.ok(!backedUp.some((b) => b.rel.includes("custom/my-skill")));
      assert.equal(
        readFileSync(join(client, ".github", "skills", "custom", "my-skill", "SKILL.md"), "utf8"),
        "# our own custom skill\n",
        "the adopter's own skill file must survive the upgrade untouched"
      );
    } finally {
      rmSync(kit, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });
});

describe("upgrade-lib edge cases", () => {
  function tmp(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  it("mergePackageJson only replaces a Hyperion-style test script and merges bin", () => {
    const kit = { scripts: { test: "npm run hyperion:test" }, bin: { hyperion: "./cli.mjs" }, type: "module" };
    assert.equal(mergePackageJson({ scripts: { test: "jest" } }, kit).scripts.test, "jest");
    assert.equal(mergePackageJson({ scripts: { test: "npm run cards:test" } }, kit).scripts.test, "npm run hyperion:test");
    const fresh = mergePackageJson({ bin: { app: "./app.js" } }, kit);
    assert.equal(fresh.scripts.test, "npm run hyperion:test");
    assert.deepEqual(fresh.bin, { app: "./app.js", hyperion: "./cli.mjs" });
    assert.equal(fresh.type, "module");
    assert.equal(mergePackageJson({ type: "commonjs", engines: { node: ">=18" } }, { engines: { node: ">=20" }, type: "module" }).type, "commonjs");
  });

  it("plans extra .cursor/rules files and a missing client package.json, never client-owned files", async () => {
    const kit = tmp("kit-");
    const client = tmp("client-");
    try {
      mkdirSync(join(kit, ".cursor", "rules"), { recursive: true });
      mkdirSync(join(kit, ".github", "memory"), { recursive: true });
      writeFileSync(join(kit, ".cursor", "rules", "extra.mdc"), "x\n");
      writeFileSync(join(kit, ".cursor", "rules", "notes.md"), "x\n");
      writeFileSync(join(kit, ".cursor", "rules", "ignored.txt"), "x\n");
      writeFileSync(join(kit, ".github", "project.yml"), "name: kit\n");
      writeFileSync(join(kit, ".github", "memory", "PROJECT.md"), "# kit\n");
      writeFileSync(join(kit, "package.json"), JSON.stringify({ scripts: { "hyperion:doctor": "d" } }));
      const plan = await buildUpgradePlan(kit, client);
      const byRel = Object.fromEntries(plan.map((p) => [p.rel, p]));
      assert.equal(byRel[".cursor/rules/extra.mdc"].action, "add");
      assert.equal(byRel[".cursor/rules/notes.md"].action, "add");
      assert.ok(!byRel[".cursor/rules/ignored.txt"]);
      assert.ok(!byRel[".github/project.yml"]);
      assert.ok(!byRel[".github/memory/PROJECT.md"]);
      assert.deepEqual(byRel["package.json"], { rel: "package.json", action: "add", reason: "merge-scripts" });
      assert.equal(summarizePlan(plan).preserve, 0);
    } finally {
      rmSync(kit, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });

  it("no managed file is client-owned (buildUpgradePlan relies on it to never overwrite one)", () => {
    // MANAGED_DIRS entries are filtered with isPreserved(); single files, workflows and rules are not.
    for (const rel of [...MANAGED_FILES, ".github/workflows/hyperion-x.yml", ".cursor/rules/x.mdc"]) {
      assert.equal(isPreserved(rel), false, rel);
    }
  });

  it("applyUpgradePlan is a no-op without yes, creates package.json and pins the kit's git HEAD", async () => {
    const kit = tmp("kit-");
    const client = tmp("client-");
    try {
      mkdirSync(join(kit, "scripts", "hyperion"), { recursive: true });
      writeFileSync(join(kit, "scripts", "hyperion", "doctor.mjs"), "v\n");
      writeFileSync(join(kit, "package.json"), JSON.stringify({ description: "kit", scripts: { "hyperion:doctor": "d" } }));
      const head = gitCommitAll(kit, "kit");

      const plan = await buildUpgradePlan(kit, client);
      assert.deepEqual(await applyUpgradePlan(kit, client, plan), { applied: [], backedUp: [] });
      const { applied } = await applyUpgradePlan(kit, client, plan, { yes: true });
      assert.ok(applied.includes("package.json"));
      const pkg = JSON.parse(readFileSync(join(client, "package.json"), "utf8"));
      assert.equal(pkg.private, true);
      assert.equal(pkg.scripts["hyperion:doctor"], "d");
      const meta = JSON.parse(readFileSync(join(client, ".github", "hyperion-kit.json"), "utf8"));
      assert.equal(meta.commit, head);
      assert.equal(meta.kit_description, "kit");
    } finally {
      rmSync(kit, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });

  it("applyUpgradePlan without a kit package.json still records remote metadata", async () => {
    const kit = tmp("kit-");
    const client = tmp("client-");
    try {
      mkdirSync(join(kit, "scripts", "hyperion"), { recursive: true });
      writeFileSync(join(kit, "scripts", "hyperion", "doctor.mjs"), "v\n");
      const plan = await buildUpgradePlan(kit, client);
      await applyUpgradePlan(kit, client, plan, {
        yes: true,
        remoteMeta: { repo: "acme/kit", ref: "main", commit: "abcdef1234567890" },
        sourceLabel: "github.com/acme/kit@main",
      });
      const meta = JSON.parse(readFileSync(join(client, ".github", "hyperion-kit.json"), "utf8"));
      assert.equal(meta.repo, "acme/kit");
      assert.equal(meta.ref, "main");
      assert.equal(meta.source, "github.com/acme/kit@main");
      assert.equal(meta.kit_description, undefined);
      assert.match(readFileSync(join(client, "CHANGELOG.md"), "utf8"), /\(abcdef123456\)/);
    } finally {
      rmSync(kit, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });

  it("recordUpgradeChangelog injects under an existing [Unreleased] heading once", async () => {
    const client = tmp("client-");
    try {
      writeFileSync(join(client, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n- first\n");
      const meta = { upgraded_at: "2026-01-02T00:00:00.000Z" };
      await recordUpgradeChangelog(client, meta, 3);
      await recordUpgradeChangelog(client, meta, 3);
      const text = readFileSync(join(client, "CHANGELOG.md"), "utf8");
      assert.equal(
        text,
        "# Changelog\n\n## [Unreleased]\n\n### Changed\n- Hyperion kit upgrade 2026-01-02 — 3 paths updated\n\n## [1.0.0]\n- first\n"
      );
      await recordUpgradeChangelog(client, {}, 1);
      assert.match(readFileSync(join(client, "CHANGELOG.md"), "utf8"), /- Hyperion kit upgrade \d{4}-\d{2}-\d{2} — 1 paths updated/);
    } finally {
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
