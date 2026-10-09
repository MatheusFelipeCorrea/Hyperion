import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { inspectProductCiGates } from "./pipeline-lib.mjs";
import { renderProductCiForRepo } from "./product-ci-render.mjs";

const SCRIPT = fileURLToPath(new URL("./pipeline-apply.mjs", import.meta.url));
const env = { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() };
delete env.HYPERION_ROOT;
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;

const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const WF = ".github/workflows";
const TEMPLATES = {
  "hyperion-security.yml": "name: fixture security\n",
  "hyperion-validate.yml": "name: fixture validate\n",
  "hyperion-product-ci.yml": "name: fixture product ci\n",
};

// A minimal .git whose origin/HEAD resolves on the first `git symbolic-ref` probe
// keeps detectDefaultBranch to one git spawn per call (failed probes are slow on Windows).
const FAKE_GIT = {
  ".git/HEAD": "ref: refs/heads/main\n",
  ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/main\n",
  ".git/refs/heads/.keep": "",
  ".git/objects/.keep": "",
};

function makeRepo(files = {}, { templates = true, kitDir = "", defaultBranch = "main" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-apply-"));
  roots.push(root);
  const all = { ...FAKE_GIT, ...files };
  if (defaultBranch) all[".git/refs/remotes/origin/HEAD"] = `ref: refs/remotes/origin/${defaultBranch}\n`;
  else delete all[".git/refs/remotes/origin/HEAD"];
  if (templates) {
    for (const [name, text] of Object.entries(TEMPLATES)) {
      all[path.posix.join(kitDir, "scripts/hyperion/templates/workflows", name)] = text;
    }
  }
  for (const [rel, content] of Object.entries(all)) write(root, rel, content);
  return root;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

function apply(root, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const projectYml = (ci) => `project:\n  name: demo\nci:\n${ci}`;

describe("pipeline-apply: greenfield GitHub repo", () => {
  const root = makeRepo({
    ".github/project.yml": projectYml("  policy: detect\n  hyperion:\n    kit_validation: true\n"),
  });
  const files = [
    "hyperion-sync-cards.yml",
    "hyperion-cards-pr-check.yml",
    "hyperion-cards-pr-recheck.yml",
    "hyperion-security.yml",
    "hyperion-validate.yml",
    "hyperion-product-ci.yml",
  ].map((n) => `${WF}/${n}`);

  it("--yes renders kit workflows and copies the static templates; a re-run has nothing to apply", () => {
    const r = apply(root, "--yes");
    assert.equal(r.status, 0, r.out);
    for (const f of files) assert.ok(exists(root, f), f);
    assert.equal(read(root, `${WF}/hyperion-security.yml`), TEMPLATES["hyperion-security.yml"]);
    assert.equal(read(root, `${WF}/hyperion-product-ci.yml`), TEMPLATES["hyperion-product-ci.yml"]);
    assert.match(r.out, /Pipeline apply complete \(6 file\(s\) written\)/);

    const again = apply(root);
    assert.equal(again.status, 0);
    assert.match(again.out, /Nothing to apply\. Run pipeline-detect/);
  });

  it("--refresh-sync is a dry run without --yes, then rewrites outdated workflows", () => {
    write(root, `${WF}/hyperion-sync-cards.yml`, "name: stale\n");
    write(root, `${WF}/hyperion-cards-pr-recheck.yml`, "name: stale\n");
    const dry = apply(root, "--refresh-sync");
    assert.equal(dry.status, 0);
    assert.match(dry.out, /Refresh sync \(default branch: main, kit: root\)/);
    assert.match(dry.out, /Dry-run refresh/);
    assert.match(dry.out, /hyperion-sync-cards\.yml outdated \(/);
    assert.match(dry.out, /= \.github\/workflows\/hyperion-cards-pr-check\.yml \(up to date\)/);
    assert.equal(read(root, `${WF}/hyperion-sync-cards.yml`), "name: stale\n");

    const wet = apply(root, "--refresh-sync", "--yes");
    assert.equal(wet.status, 0, wet.out);
    assert.match(wet.out, /Refreshed \.github\/workflows\/hyperion-sync-cards\.yml/);
    assert.match(wet.out, /Refreshed \.github\/workflows\/hyperion-cards-pr-recheck\.yml/);
    assert.match(wet.out, /Refresh complete \(2 file\(s\) updated\)/);
    assert.match(wet.out, /Pipeline apply complete \(0 file\(s\) written\)/);
    assert.notEqual(read(root, `${WF}/hyperion-sync-cards.yml`), "name: stale\n");
  });
});

describe("pipeline-apply: policies, legacy migration and failures", () => {
  it("ci.policy=skip writes nothing", () => {
    const root = makeRepo({ ".github/project.yml": projectYml("  policy: skip\n") });
    const r = apply(root, "--yes");
    assert.equal(r.status, 0);
    assert.match(r.out, /ci\.policy=skip — no workflows written/);
    assert.ok(!exists(root, WF));
  });

  it("--migrate-legacy previews, warns without --yes, then removes legacy workflows", () => {
    const root = makeRepo({
      [`${WF}/ci.yml`]: "name: ci\n",
      [`${WF}/sync-cards.yml`]: "name: sync\n",
    });
    const preview = apply(root, "--migrate-legacy");
    assert.equal(preview.status, 0);
    assert.match(preview.out, /Legacy kit workflows found \(ci\.yml, sync-cards\.yml\)/);
    assert.match(preview.out, /Dry-run only\. Re-run with --yes/);
    assert.ok(preview.out.includes(`  ${WF}/hyperion-security.yml`));
    assert.ok(!exists(root, `${WF}/hyperion-security.yml`));

    const written = apply(root, "--yes");
    assert.match(written.out, /Pipeline apply complete \(4 file\(s\) written\)/);
    assert.ok(!exists(root, `${WF}/hyperion-product-ci.yml`), "product CI exists → no generic product CI");

    const warnOnly = apply(root, "--migrate-legacy");
    assert.equal(warnOnly.status, 0);
    assert.match(warnOnly.out, /Run with --yes --migrate-legacy to remove/);
    assert.ok(exists(root, `${WF}/ci.yml`));

    const migrated = apply(root, "--migrate-legacy", "--yes");
    assert.equal(migrated.status, 0, migrated.out);
    assert.match(migrated.out, /Removed legacy \.github\/workflows\/ci\.yml/);
    assert.match(migrated.out, /Removed legacy \.github\/workflows\/sync-cards\.yml/);
    assert.ok(!exists(root, `${WF}/ci.yml`));
    assert.ok(!exists(root, `${WF}/sync-cards.yml`));
  });

  it("fails with exit 1 when a static template is missing", () => {
    const root = makeRepo({}, { templates: false });
    const r = apply(root, "--yes");
    assert.equal(r.status, 1);
    assert.match(r.out, /❌ .*ENOENT.*hyperion-security\.yml/);
  });

  it("nested kit layout reads static templates from kit.root and renders the recheck inside it", () => {
    const root = makeRepo({ "Hyperion/.github/cards/.keep": "" }, { kitDir: "Hyperion" });
    const r = apply(root, "--yes");
    assert.equal(r.status, 0, r.out);
    assert.equal(read(root, `${WF}/hyperion-security.yml`), TEMPLATES["hyperion-security.yml"]);
    assert.match(read(root, `${WF}/hyperion-cards-pr-recheck.yml`), /working-directory: Hyperion/);

    write(root, `${WF}/hyperion-cards-pr-recheck.yml`, read(root, `${WF}/hyperion-cards-pr-recheck.yml`).replace(/\n {4}defaults:\n.*\n.*working-directory: Hyperion/, ""));
    const refreshed = apply(root, "--refresh-sync", "--yes");
    assert.equal(refreshed.status, 0, refreshed.out);
    assert.match(refreshed.out, /Refreshed \.github\/workflows\/hyperion-cards-pr-recheck\.yml \(missing_working_directory\)/);
    assert.match(read(root, `${WF}/hyperion-cards-pr-recheck.yml`), /working-directory: Hyperion/);
  });

  it("passes the detected default branch to the recheck workflow on apply and --refresh-sync", () => {
    const root = makeRepo({}, { defaultBranch: "dev" });
    const recheck = `${WF}/hyperion-cards-pr-recheck.yml`;
    const r = apply(root, "--yes");
    assert.equal(r.status, 0, r.out);
    const written = load(read(root, recheck));
    assert.match(written.jobs["list-open-prs"].steps[0].with.script, /base: "dev"/);
    assert.doesNotMatch(read(root, recheck), /base: "main"/);
    assert.equal(written.jobs.recheck.defaults, undefined, "root kit → no working-directory");

    write(root, recheck, read(root, recheck).replace('base: "dev"', 'base: "main"'));
    const refreshed = apply(root, "--refresh-sync", "--yes");
    assert.equal(refreshed.status, 0, refreshed.out);
    assert.match(refreshed.out, /Refresh sync \(default branch: dev, kit: root\)/);
    assert.match(refreshed.out, /Refreshed \.github\/workflows\/hyperion-cards-pr-recheck\.yml \(base_branch_mismatch\)/);
    assert.match(read(root, recheck), /base: "dev"/);
  });

  it("a fresh repo on feature/x without origin/HEAD never targets feature/x and keeps a correct recheck", () => {
    const root = makeRepo({ ".git/HEAD": "ref: refs/heads/feature/x\n" }, { defaultBranch: null });
    const recheck = `${WF}/hyperion-cards-pr-recheck.yml`;
    const r = apply(root, "--yes");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /origin\/HEAD is not set — generated workflows target "main"/);
    for (const name of ["hyperion-sync-cards.yml", "hyperion-cards-pr-check.yml", "hyperion-cards-pr-recheck.yml"]) {
      assert.doesNotMatch(read(root, `${WF}/${name}`), /feature\/x/, name);
    }
    assert.match(read(root, recheck), /base: "main"/);

    const correct = read(root, recheck).replace('base: "main"', 'base: "dev"');
    write(root, recheck, correct);
    const refreshed = apply(root, "--refresh-sync", "--yes");
    assert.equal(refreshed.status, 0, refreshed.out);
    assert.match(refreshed.out, /= \.github\/workflows\/hyperion-cards-pr-recheck\.yml \(up to date\)/);
    assert.doesNotMatch(refreshed.out, /base_branch_mismatch/);
    assert.equal(read(root, recheck), correct);
  });
});

describe("pipeline-apply: ci.gates product CI", () => {
  const gates = (min) =>
    projectYml(`  hyperion:\n    cards_sync: false\n    security_scan: false\n  gates:\n    defaults:\n      coverage: { mode: warn, min: ${min} }\n`);
  const productCi = `${WF}/hyperion-product-ci.yml`;
  const root = makeRepo({
    ".github/project.yml": gates(70),
    [productCi]: "name: generic product ci\n",
    "package.json": JSON.stringify({ name: "app", scripts: { test: "node --test" } }),
    "package-lock.json": "{}",
  });

  it("keeps a generic product CI until --refresh-gates, then renders it from ci.gates", () => {
    const skipped = apply(root, "--yes");
    assert.equal(skipped.status, 0, skipped.out);
    assert.match(skipped.out, /differs from ci\.gates/);
    assert.match(skipped.out, /Exists — skipped: \.github\/workflows\/hyperion-product-ci\.yml \(ci\.gates changed/);
    assert.equal(read(root, productCi), "name: generic product ci\n");

    const refreshed = apply(root, "--refresh-gates", "--yes");
    assert.equal(refreshed.status, 0, refreshed.out);
    assert.match(refreshed.out, /Wrote \.github\/workflows\/hyperion-product-ci\.yml/);
    assert.match(read(root, productCi), /^# hyperion:gates-hash [0-9a-f]+$/m);
  });

  const gatesObj = (min) => ({ defaults: { coverage: { mode: "warn", min } } });
  const hash = (text) => text.match(/^# hyperion:gates-hash ([0-9a-f]+)$/m)?.[1] ?? null;
  // Own repo per test: project.yml at `min` and a product CI freshly generated from it.
  function generatedRepo(min, header = "") {
    const repo = makeRepo({
      ".github/project.yml": gates(min),
      "package.json": JSON.stringify({ name: "app", scripts: { test: "node --test" } }),
      "package-lock.json": "{}",
    });
    write(repo, productCi, `${header}${renderProductCiForRepo(repo, { gates: gatesObj(min) }).content}`);
    return repo;
  }

  it("a generated product CI is not treated as pinned (so --refresh-gates can re-render it)", async () => {
    const repo = generatedRepo(70);
    const generated = read(repo, productCi);
    assert.match(generated, /hyperion:no-auto-refresh/, "the header mentions the marker in prose");
    const fresh = await inspectProductCiGates(repo, gatesObj(70));
    assert.deepEqual([fresh.exists, fresh.noAutoRefresh, fresh.currentHash], [true, false, fresh.expectedHash]);

    write(repo, ".github/project.yml", gates(90));
    const stale = await inspectProductCiGates(repo, gatesObj(90));
    assert.equal(stale.noAutoRefresh, false);
    assert.notEqual(stale.currentHash, stale.expectedHash);
    const rerendered = apply(repo, "--refresh-gates", "--yes");
    assert.equal(rerendered.status, 0, rerendered.out);
    assert.match(rerendered.out, /Wrote \.github\/workflows\/hyperion-product-ci\.yml/);
    assert.equal(hash(read(repo, productCi)), stale.expectedHash);
  });

  it("a product CI the user pinned with the opt-out marker is skipped by --refresh-gates", async () => {
    const repo = generatedRepo(70, "# hyperion:no-auto-refresh — hand-tuned\n");
    write(repo, ".github/project.yml", gates(50));
    const state = await inspectProductCiGates(repo, gatesObj(50));
    assert.equal(state.noAutoRefresh, true);
    assert.notEqual(state.currentHash, state.expectedHash, "stale, so only the marker prevents a refresh");
    const pinned = read(repo, productCi);
    const r = apply(repo, "--refresh-gates", "--yes");
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Wrote \.github\/workflows\/hyperion-product-ci\.yml/);
    assert.equal(read(repo, productCi), pinned);
  });
});

describe("pipeline-apply: GitLab and Azure snippets", () => {
  const root = makeRepo({ ".gitlab-ci.yml": "stages: [test]\n", "azure-pipelines.yml": "trigger: [main]\n" });
  const gitlab = ".gitlab/hyperion-ci.yml";
  const azure = "hyperion-azure-pipelines.yml";

  it("writes both include snippets, then skips existing ones", () => {
    const first = apply(root, "--yes");
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /GitLab: add `include: - local: \.gitlab\/hyperion-ci\.yml`/);
    assert.match(first.out, /Azure: reference hyperion-azure-pipelines\.yml/);
    assert.ok(exists(root, gitlab) && exists(root, azure));
    assert.ok(!exists(root, WF), "no GitHub workflows on GitLab/Azure");

    const second = apply(root, "--yes");
    assert.match(second.out, /Exists — skipped: \.gitlab\/hyperion-ci\.yml/);
    assert.match(second.out, /Exists — skipped: hyperion-azure-pipelines\.yml/);
  });

  it("--refresh-sync refreshes an outdated snippet and skips up-to-date ones", () => {
    write(root, azure, "# stale\n");
    const r = apply(root, "--refresh-sync", "--yes");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /= \.gitlab\/hyperion-ci\.yml \(up to date\)/);
    assert.match(r.out, /Refreshed hyperion-azure-pipelines\.yml/);
    assert.match(r.out, /Exists and up to date — skipped: \.gitlab\/hyperion-ci\.yml/);
    assert.match(r.out, /Exists and up to date — skipped: hyperion-azure-pipelines\.yml/);
    assert.notEqual(read(root, azure), "# stale\n");
  });
});
