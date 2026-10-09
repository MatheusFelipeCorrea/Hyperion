import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildUpgradePlan,
  applyUpgradePlan,
  mergePackageJson,
  mergeGitignore,
  isPreserved,
  summarizePlan,
  recordUpgradeChangelog,
  KIT_ONLY_WORKFLOWS,
  detectLeakedKitWorkflows,
  formatLeakedKitWorkflowsHelp,
  formatWorkflowRefreshHelp,
} from "./upgrade-lib.mjs";
import {
  HYPERION_WORKFLOWS,
  renderSyncCardsWorkflow,
  renderPrBoardGuardWorkflow,
  renderPrRecheckWorkflow,
} from "./pipeline-lib.mjs";
import { sameCommit, resolveOrigin, DEFAULT_ORIGIN } from "./upgrade-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const kitRepoRoot = join(__dirname, "..", "..");

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
      assert.ok(!byRel[".github/workflows/hyperion-validate.yml"], "kit's own CI must never reach a product");
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
      assert.ok(!existsSync(join(client, ".github", "workflows", "hyperion-validate.yml")));
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

describe("leaked kit workflows", () => {
  const kitWorkflow = (name) => readFileSync(join(kitRepoRoot, ".github", "workflows", name), "utf8");
  const writeWorkflows = (root, files, { pin = true } = {}) => {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(root, ".github", "workflows", name), text);
    }
    if (pin) writeFileSync(join(root, ".github", "hyperion-kit.json"), '{ "kit_name": "hyperion" }\n');
  };
  const allKitOnly = () =>
    Object.fromEntries(KIT_ONLY_WORKFLOWS.map((wf) => [wf.file, kitWorkflow(wf.file)]));

  it("reports nothing without the upgrade pin (the kit's own checkout)", async () => {
    const kitLike = mkdtempSync(join(tmpdir(), "kit-"));
    try {
      writeWorkflows(kitLike, allKitOnly(), { pin: false });
      assert.deepEqual(await detectLeakedKitWorkflows(kitLike), []);
      assert.deepEqual(await detectLeakedKitWorkflows(kitRepoRoot), []);
    } finally {
      rmSync(kitLike, { recursive: true, force: true });
    }
  });

  it("flags every kit-only workflow as this kit ships it", async () => {
    const client = mkdtempSync(join(tmpdir(), "client-"));
    try {
      writeWorkflows(client, allKitOnly());
      const found = await detectLeakedKitWorkflows(client);
      assert.deepEqual(
        found.map((f) => f.rel).sort(),
        KIT_ONLY_WORKFLOWS.map((wf) => `.github/workflows/${wf.file}`).sort()
      );
      assert.ok(found.every((f) => f.why));
    } finally {
      rmSync(client, { recursive: true, force: true });
    }
  });

  it("leaves product workflows rendered by /pipeline alone", async () => {
    const client = mkdtempSync(join(tmpdir(), "client-"));
    try {
      const template = (name) =>
        readFileSync(join(__dirname, "templates", "workflows", name), "utf8");
      writeWorkflows(client, {
        [HYPERION_WORKFLOWS.syncCards]: renderSyncCardsWorkflow(),
        [HYPERION_WORKFLOWS.cardsPrGuard]: renderPrBoardGuardWorkflow(),
        [HYPERION_WORKFLOWS.cardsPrRecheck]: renderPrRecheckWorkflow(),
        [HYPERION_WORKFLOWS.validate]: template(HYPERION_WORKFLOWS.validate),
        [HYPERION_WORKFLOWS.security]: kitWorkflow(HYPERION_WORKFLOWS.security),
        [HYPERION_WORKFLOWS.productCi]: template(HYPERION_WORKFLOWS.productCi),
        "product.yml": "name: product\n",
      });
      assert.deepEqual(await detectLeakedKitWorkflows(client), []);
    } finally {
      rmSync(client, { recursive: true, force: true });
    }
  });

  it("formatLeakedKitWorkflowsHelp says which files to delete, then pipeline-apply --yes", () => {
    assert.deepEqual(formatLeakedKitWorkflowsHelp([]), []);
    const lines = formatLeakedKitWorkflowsHelp([
      { rel: ".github/workflows/hyperion-validate.yml", why: "a" },
      { rel: ".github/workflows/hyperion-e2e-cards.yml", why: "b" },
    ]);
    const text = lines.join("\n");
    assert.match(text, /hyperion-validate\.yml — a/);
    assert.ok(
      lines.includes("  git rm .github/workflows/hyperion-validate.yml .github/workflows/hyperion-e2e-cards.yml")
    );
    assert.ok(lines.includes("  npm run hyperion:pipeline-apply -- --yes"));
    assert.ok(
      text.indexOf("git rm") < text.indexOf("pipeline-apply -- --yes"),
      "delete first, then regenerate"
    );
  });

  it("formatWorkflowRefreshHelp names exactly the files pipeline-apply --refresh-sync rewrites", () => {
    const source = readFileSync(join(__dirname, "pipeline-apply.mjs"), "utf8");
    const block = source.slice(source.indexOf("const REFRESH_TARGETS = ["));
    const targets = block.slice(0, block.indexOf("\n];"));
    const keys = [...new Set([...targets.matchAll(/HYPERION_WORKFLOWS\.(\w+)/g)].map((m) => m[1]))];
    assert.deepEqual(keys.sort(), ["cardsPrGuard", "cardsPrRecheck", "syncCards"]);

    const lines = formatWorkflowRefreshHelp();
    const refreshSync = lines.find((l) => l.includes("--refresh-sync"));
    for (const key of keys) assert.ok(refreshSync.includes(HYPERION_WORKFLOWS[key]), key);
    assert.match(refreshSync, /GitLab\/Azure/);
    for (const key of ["security", "validate", "productCi"]) {
      assert.ok(!refreshSync.includes(HYPERION_WORKFLOWS[key]), `${key} is not a --refresh-sync target`);
    }
    assert.match(lines.find((l) => l.includes("--refresh-gates")), /hyperion-product-ci\.yml/);
    const notRefreshed = lines.find((l) => l.startsWith("Neither"));
    assert.match(notRefreshed, /hyperion-security\.yml/);
    assert.match(notRefreshed, /hyperion-validate\.yml/);
  });

  it("hyperion:upgrade prints the leaked files on a dry-run and the refresh help after applying", () => {
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    const client = mkdtempSync(join(tmpdir(), "client-"));
    try {
      makeKit(kit);
      makeClient(client);
      writeWorkflows(client, { "hyperion-docker-publish.yml": kitWorkflow("hyperion-docker-publish.yml") });
      const run = (...extra) =>
        spawnSync(process.execPath, [join(__dirname, "upgrade.mjs"), "--from", kit, ...extra], {
          cwd: client,
          encoding: "utf8",
        });

      const dry = run();
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /git rm \.github\/workflows\/hyperion-docker-publish\.yml/);
      assert.match(dry.stdout, /npm run hyperion:pipeline-apply -- --yes/);
      assert.ok(existsSync(join(client, ".github", "workflows", "hyperion-docker-publish.yml")), "never deletes on its own");

      const applied = run("--yes");
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /--refresh-sync --yes .*hyperion-cards-pr-recheck\.yml/);
      assert.match(applied.stdout, /Neither refreshes hyperion-security\.yml or hyperion-validate\.yml/);
    } finally {
      rmSync(kit, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });

  it("hyperion:doctor warns about leaked kit workflows without changing its exit code", () => {
    const clean = mkdtempSync(join(tmpdir(), "client-"));
    const leaked = mkdtempSync(join(tmpdir(), "client-"));
    try {
      for (const dir of [clean, leaked]) makeClient(dir);
      writeWorkflows(clean, {});
      writeWorkflows(leaked, {
        [HYPERION_WORKFLOWS.validate]: kitWorkflow(HYPERION_WORKFLOWS.validate),
        "hyperion-e2e-cards.yml": kitWorkflow("hyperion-e2e-cards.yml"),
      });
      const doctor = (cwd) =>
        spawnSync(process.execPath, [join(__dirname, "doctor.mjs"), "--skip-cards"], {
          cwd,
          encoding: "utf8",
        });

      const before = doctor(clean);
      const after = doctor(leaked);
      assert.equal(after.status, before.status, "a warning, never a failure");
      assert.doesNotMatch(before.stdout, /kit's own CI/);

      const lines = after.stdout.split(/\r?\n/);
      const head = lines.find((l) => l.includes("kit's own CI, copied by an earlier hyperion:upgrade"));
      assert.ok(head, after.stdout);
      assert.match(head, /⚠️/);
      assert.ok(
        lines.some((l) =>
          l.endsWith("git rm .github/workflows/hyperion-validate.yml .github/workflows/hyperion-e2e-cards.yml")
        ),
        after.stdout
      );
      assert.ok(lines.some((l) => l.endsWith("npm run hyperion:pipeline-apply -- --yes")), after.stdout);
    } finally {
      rmSync(clean, { recursive: true, force: true });
      rmSync(leaked, { recursive: true, force: true });
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
