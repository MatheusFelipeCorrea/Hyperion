import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendForkGuardJob,
  auditHyperionPipelineFiles,
  detectExternalProviders,
  detectPipeline,
  detectStack,
  formatCiYamlBlock,
  inspectProductCiGates,
  listGithubWorkflows,
  NO_AUTO_REFRESH_MARKER,
  readCardsSyncMode,
  readCiGatesFromProjectYml,
  renderPrBoardGuardForkWorkflow,
  resolvePipelineRenderOptions,
  classifyWorkflows,
  buildPipelinePlan,
  readCiFromProjectYml,
  DEFAULT_CI_CONFIG,
  renderSyncCardsWorkflow,
  renderPrBoardGuardWorkflow,
  renderPrRecheckWorkflow,
  auditPrBoardGuardWorkflow,
  auditPrRecheckWorkflow,
  renderGitLabHyperionCi,
  renderAzureHyperionCi,
  auditSyncCardsWorkflow,
  auditGitLabHyperionCi,
  auditAzureHyperionCi,
  detectDefaultBranch,
} from "./pipeline-lib.mjs";

describe("classifyWorkflows", () => {
  it("separates hyperion, product, and legacy", () => {
    const r = classifyWorkflows([
      "ci.yml",
      "deploy.yml",
      "hyperion-sync-cards.yml",
      "hyperion-validate.yml",
    ]);
    assert.deepEqual(r.legacy, ["ci.yml"]);
    assert.deepEqual(r.product, ["deploy.yml"]);
    assert.deepEqual(r.hyperion, ["hyperion-sync-cards.yml", "hyperion-validate.yml"]);
  });
});

describe("readCiFromProjectYml", () => {
  it("parses hyperion flags", () => {
    const yaml = `
ci:
  provider: github-actions
  policy: detect
  stack: auto
  hyperion:
    cards_sync: true
    kit_validation: true
    security_scan: false
    product_ci: auto
`;
    const cfg = readCiFromProjectYml(yaml);
    assert.equal(cfg.hyperion.kit_validation, true);
    assert.equal(cfg.hyperion.security_scan, false);
  });
});

describe("buildPipelinePlan", () => {
  it("skips product CI when detect + existing product workflow", () => {
    const detection = {
      config: { ...DEFAULT_CI_CONFIG, policy: "detect", hyperion: { ...DEFAULT_CI_CONFIG.hyperion } },
      hasProductCi: true,
      classified: { legacy: [], product: ["deploy.yml"], hyperion: [] },
      stack: "node-npm",
      external: [],
    };
    const plan = buildPipelinePlan(detection);
    assert.ok(plan.skips.some((s) => s.includes("hyperion-product-ci")));
    assert.ok(plan.actions.some((a) => a.template === "hyperion-sync-cards.yml"));
  });

  it("generates product CI for greenfield detect", () => {
    const detection = {
      config: { ...DEFAULT_CI_CONFIG, policy: "detect", hyperion: { ...DEFAULT_CI_CONFIG.hyperion } },
      hasProductCi: false,
      classified: { legacy: [], product: [], hyperion: [] },
      stack: "node-npm",
      external: [],
    };
    const plan = buildPipelinePlan(detection);
    assert.ok(plan.actions.some((a) => a.template === "hyperion-product-ci.yml"));
  });

  it("respects policy skip", () => {
    const detection = {
      config: { ...DEFAULT_CI_CONFIG, policy: "skip", hyperion: { ...DEFAULT_CI_CONFIG.hyperion } },
      hasProductCi: false,
      classified: { legacy: [], product: [], hyperion: [] },
      stack: "unknown",
      external: [],
    };
    const plan = buildPipelinePlan(detection);
    assert.equal(plan.actions.length, 0);
    assert.ok(plan.skips.length > 0);
  });

  it("plans GitLab include snippet when gitlab-ci detected", () => {
    const detection = {
      config: {
        ...DEFAULT_CI_CONFIG,
        provider: "gitlab-ci",
        policy: "merge",
        hyperion: { ...DEFAULT_CI_CONFIG.hyperion, cards_sync: true, kit_validation: true },
      },
      hasProductCi: true,
      classified: { legacy: [], product: [], hyperion: [] },
      stack: "node-npm",
      external: [{ provider: "gitlab-ci", file: ".gitlab-ci.yml" }],
    };
    const plan = buildPipelinePlan(detection);
    assert.ok(plan.actions.some((a) => a.file === ".gitlab/hyperion-ci.yml" && a.templateDir === "ci"));
    assert.ok(!plan.actions.some((a) => a.template === "hyperion-sync-cards.yml"));
  });

  it("skips hyperion-owned workflows that already exist on disk", () => {
    const detection = {
      config: {
        ...DEFAULT_CI_CONFIG,
        policy: "detect",
        hyperion: { ...DEFAULT_CI_CONFIG.hyperion, kit_validation: true },
      },
      hasProductCi: true,
      classified: {
        legacy: [],
        product: [],
        hyperion: [
          "hyperion-sync-cards.yml",
          "hyperion-cards-pr-check.yml",
          "hyperion-cards-pr-recheck.yml",
          "hyperion-security.yml",
          "hyperion-validate.yml",
        ],
      },
      stack: "node-npm",
      external: [],
    };
    const plan = buildPipelinePlan(detection);
    assert.equal(plan.actions.length, 0, "should not re-plan any already-existing hyperion workflow");
    for (const name of detection.classified.hyperion) {
      assert.ok(plan.skips.some((s) => s.includes(name)), `expected a skip entry for ${name}`);
    }
  });

  it("skips hyperion-product-ci.yml when it already exists, even though hasProductCi only tracks non-hyperion files", () => {
    const detection = {
      config: { ...DEFAULT_CI_CONFIG, policy: "detect", hyperion: { ...DEFAULT_CI_CONFIG.hyperion } },
      hasProductCi: false, // matches detectPipeline: hyperion-prefixed files never count here
      classified: { legacy: [], product: [], hyperion: ["hyperion-product-ci.yml"] },
      stack: "node-npm",
      external: [],
    };
    const plan = buildPipelinePlan(detection);
    assert.ok(!plan.actions.some((a) => a.template === "hyperion-product-ci.yml"));
    assert.ok(plan.skips.some((s) => s.includes("hyperion-product-ci.yml")));
  });

  it("plans Azure Pipelines template when azure-pipelines detected", () => {
    const detection = {
      config: {
        ...DEFAULT_CI_CONFIG,
        provider: "azure-pipelines",
        policy: "detect",
        hyperion: { ...DEFAULT_CI_CONFIG.hyperion, security_scan: true },
      },
      hasProductCi: true,
      classified: { legacy: [], product: [], hyperion: [] },
      stack: "dotnet",
      external: [{ provider: "azure-pipelines", file: "azure-pipelines.yml" }],
    };
    const plan = buildPipelinePlan(detection);
    assert.ok(plan.actions.some((a) => a.file === "hyperion-azure-pipelines.yml"));
  });

  it("product_ci: true (parsed as string from project.yml) generates product CI alongside existing workflows", () => {
    const cfg = readCiFromProjectYml("ci:\n  policy: detect\n  hyperion:\n    product_ci: true\n");
    const detection = {
      config: { ...DEFAULT_CI_CONFIG, ...cfg, existing: ["deploy.yml"] },
      hasProductCi: true,
      classified: { legacy: [], product: ["deploy.yml"], hyperion: [] },
      stack: "node-npm",
      external: [],
    };
    const plan = buildPipelinePlan(detection);
    assert.ok(plan.actions.some((a) => a.template === "hyperion-product-ci.yml"));
  });

  it("renders product CI from ci.gates when configured", () => {
    const detection = {
      config: { ...DEFAULT_CI_CONFIG, policy: "detect", hyperion: { ...DEFAULT_CI_CONFIG.hyperion }, gates: { defaults: {} } },
      hasProductCi: false,
      classified: { legacy: [], product: [], hyperion: [] },
      stack: "node-npm",
      external: [],
      productCiGates: { exists: false, currentHash: null, expectedHash: "abc", noAutoRefresh: false, apps: 2 },
    };
    const plan = buildPipelinePlan(detection);
    const action = plan.actions.find((a) => a.template === "hyperion-product-ci.yml");
    assert.equal(action?.render, "gates");
    assert.ok(!action.replace);
  });

  it("plans a --refresh-gates replace when ci.gates changed, skips when hash matches or opted out", () => {
    const base = {
      config: { ...DEFAULT_CI_CONFIG, policy: "detect", hyperion: { ...DEFAULT_CI_CONFIG.hyperion }, gates: { defaults: {} } },
      hasProductCi: false,
      classified: { legacy: [], product: [], hyperion: ["hyperion-product-ci.yml"] },
      stack: "node-npm",
      external: [],
    };
    const stale = buildPipelinePlan({ ...base, productCiGates: { exists: true, currentHash: "old", expectedHash: "new", noAutoRefresh: false, apps: 1 } });
    assert.ok(stale.actions.some((a) => a.render === "gates" && a.replace));
    const fresh = buildPipelinePlan({ ...base, productCiGates: { exists: true, currentHash: "same", expectedHash: "same", noAutoRefresh: false, apps: 1 } });
    assert.ok(!fresh.actions.some((a) => a.template === "hyperion-product-ci.yml"));
    const pinned = buildPipelinePlan({ ...base, productCiGates: { exists: true, currentHash: "old", expectedHash: "new", noAutoRefresh: true, apps: 1 } });
    assert.ok(!pinned.actions.some((a) => a.template === "hyperion-product-ci.yml"));
    assert.ok(pinned.skips.some((s) => s.includes("no-auto-refresh")));
  });

  it("product_ci: false wins over ci.gates", () => {
    const detection = {
      config: { ...DEFAULT_CI_CONFIG, policy: "detect", hyperion: { ...DEFAULT_CI_CONFIG.hyperion, product_ci: "false" }, gates: { defaults: {} } },
      hasProductCi: false,
      classified: { legacy: [], product: [], hyperion: [] },
      stack: "node-npm",
      external: [],
      productCiGates: { exists: false, currentHash: null, expectedHash: "x", noAutoRefresh: false, apps: 1 },
    };
    assert.ok(!buildPipelinePlan(detection).actions.some((a) => a.template === "hyperion-product-ci.yml"));
  });
});

describe("readCiGatesFromProjectYml", () => {
  it("parses nested gates with js-yaml and ignores files without them", async () => {
    const { readCiGatesFromProjectYml } = await import("./pipeline-lib.mjs");
    const text = "ci:\n  policy: detect\n  gates:\n    defaults:\n      coverage: { mode: block, min: 85 }\n    apps:\n      api:\n        path: apps/api\n";
    const gates = await readCiGatesFromProjectYml(text);
    assert.equal(gates.defaults.coverage.min, 85);
    assert.equal(gates.apps.api.path, "apps/api");
    assert.equal(await readCiGatesFromProjectYml("ci:\n  policy: detect\n"), null);
  });
});

describe("renderSyncCardsWorkflow", () => {
  it("includes main branch filter and concurrency for legacy layout", () => {
    const yaml = renderSyncCardsWorkflow();
    assert.match(yaml, /branches: \[main\]/);
    assert.match(yaml, /cancel-in-progress: false/);
    assert.match(yaml, /"\.github\/cards\/\*\*\/\*\.md"/);
    assert.doesNotMatch(yaml, /working-directory:/);
  });

  it("uses nested paths and working-directory when kit.root is set", () => {
    const yaml = renderSyncCardsWorkflow({ kitRootRel: "Hyperion" });
    assert.match(yaml, /"Hyperion\/\.github\/cards\/\*\*\/\*\.md"/);
    assert.match(yaml, /working-directory: Hyperion/);
  });

  it("honors custom default branch", () => {
    const yaml = renderSyncCardsWorkflow({ defaultBranch: "master" });
    assert.match(yaml, /branches: \[master\]/);
  });

  it("auto mode: valid triggers, loop guard, commit with rebase retry + PR fallback", async () => {
    const yaml = renderSyncCardsWorkflow({ syncMode: "auto", kitRootRel: "Hyperion" });
    const { load } = await import("js-yaml");
    const doc = load(yaml);
    assert.deepEqual(Object.keys(doc.on).sort(), ["issues", "push", "schedule", "workflow_dispatch"]);
    assert.doesNotMatch(yaml, /projects_v2_item/);
    assert.equal(doc.concurrency["cancel-in-progress"], false);
    assert.equal(doc.permissions.contents, "write");
    assert.match(doc.jobs.sync.if, /\[cards-sync\]/);
    assert.equal(doc.jobs.sync.defaults.run["working-directory"], "Hyperion");
    const steps = doc.jobs.sync.steps;
    assert.ok(steps.some((s) => /sync\.mjs --auto/.test(s.run || "")));
    const commit = steps.find((s) => /git commit/.test(s.run || ""));
    assert.match(commit.run, /\[cards-sync\]/);
    assert.match(commit.run, /git pull --rebase/);
    assert.match(commit.run, /gh pr create/);
    assert.ok(steps.every((s) => !/secrets\./.test(String(s.if || ""))), "secrets are not allowed in step if");
    assert.equal(auditSyncCardsWorkflow(yaml, { kitRootRel: "Hyperion", syncMode: "auto" }).ok, true);
  });

  it("auto mode: commit subject and fallback PR follow the repo language(s)", async () => {
    const i18n = { primary: "pt-BR", languages: ["pt-BR", "en"], multilingual: ["pr", "comments", "release"] };
    const yaml = renderSyncCardsWorkflow({ syncMode: "auto", i18n });
    const { load } = await import("js-yaml");
    const commit = load(yaml).jobs.sync.steps.find((s) => /git commit/.test(s.run || ""));
    assert.match(commit.run, /git commit -m "chore\(cards\): reconcilia board e markdown \[cards-sync\]"/);
    assert.match(commit.run, /push em \$TARGET_BRANCH/);
    assert.match(commit.run, /\n<details><summary>English<\/summary>\n/);
    assert.match(commit.run, /could not push to \$TARGET_BRANCH/);
    assert.equal(auditSyncCardsWorkflow(yaml, { syncMode: "auto" }).ok, true);
  });

  it("audit flags a template that does not match cards_sync_mode", () => {
    const pullForward = renderSyncCardsWorkflow();
    const auto = renderSyncCardsWorkflow({ syncMode: "auto" });
    assert.ok(auditSyncCardsWorkflow(pullForward, { syncMode: "auto" }).issues.includes("sync_mode_mismatch"));
    assert.ok(auditSyncCardsWorkflow(auto, { syncMode: "pull-forward" }).issues.includes("sync_mode_mismatch"));
    assert.equal(auditSyncCardsWorkflow(auto).ok, true);
  });

  it("readCiFromProjectYml reads cards_sync_mode (default pull-forward)", () => {
    const base = "ci:\n  provider: github-actions\n  hyperion:\n    cards_sync: true\n";
    assert.equal(readCiFromProjectYml(base).hyperion.cards_sync_mode, "pull-forward");
    assert.equal(readCiFromProjectYml(`${base}    cards_sync_mode: auto\n`).hyperion.cards_sync_mode, "auto");
  });
});

describe("auditSyncCardsWorkflow", () => {
  it("flags missing branch filter and concurrency", () => {
    const stale = `on:\n  push:\n    paths:\n      - ".github/cards/**/*.md"\n`;
    const audit = auditSyncCardsWorkflow(stale);
    assert.equal(audit.ok, false);
    assert.ok(audit.issues.includes("missing_push_branch_filter"));
    assert.ok(audit.issues.includes("missing_concurrency_block"));
  });

  it("passes current template shape", () => {
    const yaml = renderSyncCardsWorkflow();
    const audit = auditSyncCardsWorkflow(yaml);
    assert.equal(audit.ok, true);
    assert.match(yaml, /ci-sync\.mjs/);
    assert.match(yaml, /CARDS_CI_REQUIRE_PROJECT/);
    assert.match(yaml, /timeout-minutes: 30/);
  });

  it("a stale-looking file without the marker still fails (no accidental opt-out)", () => {
    const stale = `on:\n  workflow_dispatch:\n`;
    assert.equal(auditSyncCardsWorkflow(stale).ok, false);
  });

  it("the hyperion:no-auto-refresh marker opts a customized file out of the audit, even with no push trigger", () => {
    const customized = `# hyperion:no-auto-refresh — deliberately no push trigger\non:\n  workflow_dispatch:\n`;
    const audit = auditSyncCardsWorkflow(customized);
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.issues, []);
  });

  it("this repo's own hyperion-sync-cards.yml carries the marker and audits clean (regression guard for pipeline-apply --refresh-sync reverting PR #69)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const ownWorkflowPath = path.join(here, "..", "..", ".github", "workflows", "hyperion-sync-cards.yml");
    const content = await readFile(ownWorkflowPath, "utf8");
    const audit = auditSyncCardsWorkflow(content);
    assert.equal(audit.ok, true, `expected the kit's own hyperion-sync-cards.yml to audit clean, got issues: ${audit.issues.join(", ")}`);
  });
});

describe("renderPrBoardGuardWorkflow", () => {
  it("includes pull_request trigger and pr-board-guard script", () => {
    const yaml = renderPrBoardGuardWorkflow();
    const audit = auditPrBoardGuardWorkflow(yaml);
    assert.equal(audit.ok, true);
    assert.match(yaml, /pull_request:/);
    assert.match(yaml, /pr-board-guard\.mjs/);
    assert.match(yaml, /pull_request\.head\.sha/);
    assert.match(yaml, /GITHUB_BASE_SHA/);
    assert.match(yaml, /board-guard-fork:/);
    assert.match(yaml, /merge_group:/);
    assert.match(yaml, /CARDS_CI_STRICT_GIT/);
  });
});

describe("renderPrRecheckWorkflow", () => {
  it("includes schedule, dispatch, and report script", () => {
    const yaml = renderPrRecheckWorkflow();
    const audit = auditPrRecheckWorkflow(yaml);
    assert.equal(audit.ok, true);
    assert.match(yaml, /schedule:/);
    assert.match(yaml, /hyperion-board-changed/);
    assert.match(yaml, /report-pr-guard-check\.mjs/);
  });
});

describe("renderGitLabHyperionCi", () => {
  it("includes resource_group and default branch rule", () => {
    const yaml = renderGitLabHyperionCi();
    assert.match(yaml, /resource_group: hyperion-cards-sync/);
    assert.match(yaml, /\$CI_DEFAULT_BRANCH/);
    assert.match(yaml, /pr-board-guard\.mjs/);
    const audit = auditGitLabHyperionCi(yaml);
    assert.equal(audit.ok, true);
  });

  it("uses nested paths and cd when kit.root set", () => {
    const yaml = renderGitLabHyperionCi({ kitRootRel: "Hyperion" });
    assert.match(yaml, /Hyperion\/\.github\/cards/);
    assert.match(yaml, /cd Hyperion/);
  });
});

describe("renderAzureHyperionCi", () => {
  it("includes defaultBranch parameter and branch condition", () => {
    const yaml = renderAzureHyperionCi();
    assert.match(yaml, /name: defaultBranch/);
    assert.match(yaml, /Build\.SourceBranch/);
    const audit = auditAzureHyperionCi(yaml);
    assert.equal(audit.ok, true);
  });
});

describe("detectDefaultBranch", () => {
  it("returns main or master string", () => {
    const branch = detectDefaultBranch();
    assert.match(branch, /^(main|master|[\w./-]+)$/);
  });
});

// ---------------------------------------------------------------------------
// Temp-repo coverage: audits, detection, plans and render options
// ---------------------------------------------------------------------------

const tmpRoots = [];
const savedEnv = {};
const ENV_KEYS = ["HYPERION_ROOT", "GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES"];

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.HYPERION_ROOT;
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** origin/HEAD → main resolves on the first git probe; failed probes cost seconds on Windows. */
const ORIGIN_MAIN_GIT = {
  ".git/HEAD": "ref: refs/heads/main\n",
  ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/main\n",
  ".git/refs/heads/.keep": "",
  ".git/objects/.keep": "",
};

function makeRepo(files = {}, { git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-pipeline-lib-"));
  tmpRoots.push(dir);
  for (const [rel, content] of Object.entries(git ? { ...ORIGIN_MAIN_GIT, ...files } : files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

const SHA = "1111111111111111111111111111111111111111";

/** Minimal on-disk .git (HEAD + refs, no objects) — enough for symbolic-ref / rev-parse. */
function fakeGit({ head, originHead = null, branches = [] }) {
  const files = { ".git/HEAD": `${head}\n`, ".git/objects/.keep": "" };
  if (originHead) files[".git/refs/remotes/origin/HEAD"] = `ref: refs/remotes/origin/${originHead}\n`;
  for (const b of branches) files[`.git/refs/heads/${b}`] = `${SHA}\n`;
  const dir = makeRepo(files, { git: false });
  fs.mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
  return dir;
}

describe("detectDefaultBranch (temp repos)", () => {
  it("prefers origin/HEAD, then the checked-out branch, then main/master, else main", () => {
    assert.equal(detectDefaultBranch(fakeGit({ head: "ref: refs/heads/feature", originHead: "develop" })), "develop");
    assert.equal(detectDefaultBranch(fakeGit({ head: "ref: refs/heads/trunk" })), "trunk");
    assert.equal(detectDefaultBranch(fakeGit({ head: SHA, branches: ["master"] })), "master");
    assert.equal(detectDefaultBranch(makeRepo({}, { git: false })), "main");
  });
});

describe("workflow audits (failing shapes)", () => {
  it("auditSyncCardsWorkflow: empty file, auto-mode gaps and pull-forward gaps", () => {
    assert.deepEqual(auditSyncCardsWorkflow(""), { ok: false, issues: ["missing_file"], missing: ["file"] });

    const auto = "jobs:\n  sync:\n    steps:\n      - run: node scripts/cards-sync/sync.mjs --auto\non_projects_v2_item: {}\n";
    const a = auditSyncCardsWorkflow(auto, { kitRootRel: "Hyperion/", syncMode: "auto" });
    assert.deepEqual(a.issues, [
      "missing_loop_guard",
      "missing_contents_write",
      "missing_push_retry",
      "invalid_projects_v2_item_trigger",
      "missing_push_branch_filter",
      "missing_concurrency_block",
      "missing_cancel_in_progress",
      "cards_paths_mismatch",
      "missing_working_directory",
    ]);
    assert.ok(a.missing.includes("on"));

    const pull = [
      "on:",
      "  push:",
      "    branches: [main]",
      '    paths: [".github/cards/**"]',
      "concurrency:",
      "  cancel-in-progress: false",
      "jobs:",
      "  sync:",
      "    defaults:",
      "      run:",
      "        working-directory: kit",
      "",
    ].join("\n");
    assert.deepEqual(auditSyncCardsWorkflow(pull).issues, [
      "missing_ci_pull_push",
      "missing_ci_project_requirement",
      "missing_strict_git",
      "unexpected_working_directory",
    ]);
  });

  it("GitLab, Azure, recheck and PR-guard audits list every gap", () => {
    assert.deepEqual(auditGitLabHyperionCi(""), { ok: false, issues: ["missing_file"] });
    assert.deepEqual(auditGitLabHyperionCi("stages: []\n", { kitRootRel: "Hyperion" }).issues, [
      "missing_resource_group",
      "missing_default_branch_rule",
      "cards_paths_mismatch",
      "missing_kit_cd",
    ]);
    assert.deepEqual(auditAzureHyperionCi(""), { ok: false, issues: ["missing_file"] });
    assert.deepEqual(auditAzureHyperionCi("jobs: []\n").issues, [
      "missing_default_branch_parameter",
      "missing_branch_condition",
      "missing_default_branch_parameter_ref",
    ]);
    assert.deepEqual(auditPrRecheckWorkflow(""), { ok: false, issues: ["missing_file"] });
    assert.deepEqual(auditPrRecheckWorkflow("name: x\n").issues, [
      "missing_schedule",
      "missing_repository_dispatch",
      "missing_report_script",
      "missing_dispatch_type",
    ]);
    assert.deepEqual(auditPrBoardGuardWorkflow(""), { ok: false, issues: ["missing_file"] });
    assert.deepEqual(auditPrBoardGuardWorkflow("name: x\n", { kitRootRel: "Hyperion" }).issues, [
      "missing_pull_request_trigger",
      "missing_pr_board_guard_script",
      "missing_merge_group_trigger",
      "missing_strict_git",
      "missing_pr_base_sha",
      "missing_ci_project_requirement",
      "missing_fork_validate_job",
      "cards_paths_mismatch",
      "missing_working_directory",
    ]);
  });
});

describe("nested-kit renderers", () => {
  it("PR guard and Azure honor kit.root and the default branch; the deprecated fork job honors kit.root", () => {
    const guard = renderPrBoardGuardWorkflow({ kitRootRel: "Hyperion", defaultBranch: "dev" });
    assert.equal(auditPrBoardGuardWorkflow(guard, { kitRootRel: "Hyperion" }).ok, true);
    assert.match(guard, /branches: \[dev\]/);
    const azure = renderAzureHyperionCi({ kitRootRel: "Hyperion", defaultBranch: "trunk" });
    assert.match(azure, /cd Hyperion && npm run docs:check/);
    assert.match(azure, /default: trunk/);
    assert.match(renderPrBoardGuardForkWorkflow({ kitRootRel: "Hyperion" }), /working-directory: Hyperion/);
    assert.doesNotMatch(renderPrBoardGuardForkWorkflow(), /working-directory/);
    const appended = appendForkGuardJob("name: guard\njobs:\n  board-guard:\n    runs-on: x\n");
    assert.match(appended, /board-guard-fork:/);
    assert.equal(appendForkGuardJob(appended), appended);
  });

  it("appendForkGuardJob nests the fork job under jobs:", async () => {
    const appended = appendForkGuardJob("jobs:\n  board-guard:\n    runs-on: x\n");
    assert.match(appended, /\n {2}board-guard-fork:\n/);
    const { load } = await import("js-yaml");
    assert.deepEqual(Object.keys(load(appended).jobs), ["board-guard", "board-guard-fork"]);
    assert.equal(load(appended).jobs["board-guard-fork"].defaults, undefined);
  });

  it("appendForkGuardJob runs the fork job inside kit.root when given one", async () => {
    const { load } = await import("js-yaml");
    const nested = load(appendForkGuardJob("jobs:\n  board-guard:\n    runs-on: x\n", { kitRootRel: "Hyperion" }));
    assert.equal(nested.jobs["board-guard-fork"].defaults.run["working-directory"], "Hyperion");
    assert.equal(nested.jobs["board-guard"].defaults, undefined);
  });

  it("PR recheck lists PRs against the configured base branch, not main", async () => {
    const { load } = await import("js-yaml");
    const script = (opts) => load(renderPrRecheckWorkflow(opts)).jobs["list-open-prs"].steps[0].with.script;
    assert.match(script({ defaultBranch: "trunk" }), /base: "trunk"/);
    assert.doesNotMatch(script({ defaultBranch: "trunk" }), /base: "main"/);
    assert.match(script(), /base: "main"/);
  });

  it("PR recheck runs inside kit.root and lists PRs against the default branch", async () => {
    const yaml = renderPrRecheckWorkflow({ kitRootRel: "Hyperion/", defaultBranch: "dev" });
    const { load } = await import("js-yaml");
    const doc = load(yaml);
    assert.equal(doc.jobs.recheck.defaults.run["working-directory"], "Hyperion");
    assert.equal(doc.jobs["list-open-prs"].defaults, undefined);
    assert.match(doc.jobs["list-open-prs"].steps[0].with.script, /base: "dev"/);
    assert.doesNotMatch(yaml, /base: "main"/);
    assert.equal(auditPrRecheckWorkflow(yaml, { kitRootRel: "Hyperion", defaultBranch: "dev" }).ok, true);
    assert.doesNotMatch(renderPrRecheckWorkflow(), /working-directory/);
  });

  it("auditPrRecheckWorkflow flags a root-level or main-pinned recheck for nested / non-main repos", () => {
    const legacy = renderPrRecheckWorkflow();
    assert.deepEqual(auditPrRecheckWorkflow(legacy, { kitRootRel: "Hyperion", defaultBranch: "dev" }).issues, [
      "missing_working_directory",
      "base_branch_mismatch",
    ]);
    assert.equal(auditPrRecheckWorkflow(legacy, { defaultBranch: "main" }).ok, true);
    const dynamicBase = legacy.replace('base: "main"', "base: defaultBranch");
    assert.equal(auditPrRecheckWorkflow(dynamicBase, { defaultBranch: "dev" }).ok, true);
  });
});

describe("project.yml ci parsing", () => {
  it("readCiFromProjectYml: absent block, provider/policy/stack and existing list", () => {
    assert.equal(readCiFromProjectYml(null), null);
    assert.equal(readCiFromProjectYml("version: 1\n"), null);
    const cfg = readCiFromProjectYml('ci:\n  provider: gitlab-ci\n  policy: merge\n  stack: go\n  existing:\n    - ".gitlab-ci.yml"\n    - deploy.yml\n');
    assert.equal(cfg.provider, "gitlab-ci");
    assert.equal(cfg.policy, "merge");
    assert.equal(cfg.stack, "go");
    assert.deepEqual(cfg.existing, [".gitlab-ci.yml", "deploy.yml"]);
  });

  it("readCiGatesFromProjectYml warns and returns null on invalid YAML", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    assert.equal(await readCiGatesFromProjectYml("ci:\n  gates:\n    defaults: [unclosed\n"), null);
    assert.match(warn.mock.calls[0].arguments[0], /Could not parse ci\.gates/);
    assert.equal(await readCiGatesFromProjectYml("ci:\n  gates: 3\n"), null);
  });
});

describe("repo scanning", () => {
  it("lists GitHub workflows and external CI providers", async () => {
    assert.deepEqual(await listGithubWorkflows(makeRepo()), []);
    const root = makeRepo({
      ".github/workflows/b.yaml": "",
      ".github/workflows/a.yml": "",
      ".github/workflows/notes.md": "",
      ".gitlab-ci.yml": "",
      "azure-pipelines.yaml": "",
      ".circleci/config.yml": "",
      Jenkinsfile: "",
      "bitbucket-pipelines.yml": "",
    });
    assert.deepEqual(await listGithubWorkflows(root), ["a.yml", "b.yaml"]);
    assert.deepEqual(
      (await detectExternalProviders(root)).map((e) => `${e.provider}:${e.file}`),
      ["gitlab-ci:.gitlab-ci.yml", "azure-pipelines:azure-pipelines.yaml", "circleci:.circleci/config.yml", "jenkins:Jenkinsfile", "bitbucket:bitbucket-pipelines.yml"]
    );
  });

  it("detectStack recognizes every supported ecosystem", async () => {
    const cases = [
      [{ "bun.lockb": "" }, "node-bun"],
      [{ "bun.lock": "" }, "node-bun"],
      [{ "package.json": "{}", "pnpm-lock.yaml": "" }, "node-pnpm"],
      [{ "package.json": "{}", "yarn.lock": "" }, "node-yarn"],
      [{ "package.json": "{}" }, "node-npm"],
      [{ "pyproject.toml": "" }, "python"],
      [{ "requirements.txt": "" }, "python"],
      [{ "go.mod": "" }, "go"],
      [{ "Cargo.toml": "" }, "rust"],
      [{ "pom.xml": "" }, "java-maven"],
      [{ "settings.gradle.kts": "" }, "java-gradle"],
      [{ "composer.json": "{}" }, "php"],
      [{ Gemfile: "" }, "ruby"],
      [{ "Directory.Build.props": "" }, "dotnet"],
      [{ "App.csproj": "" }, "dotnet"],
      [{ "docker-compose.yml": "" }, "docker"],
      [{ Dockerfile: "" }, "docker"],
      [{ "README.md": "" }, "unknown"],
    ];
    for (const [files, stack] of cases) {
      assert.equal(await detectStack(makeRepo(files)), stack, JSON.stringify(files));
    }
    assert.equal(await detectStack(path.join(os.tmpdir(), "hyperion-pipeline-lib-missing-xyz")), "unknown");
  });

  it("detectPipeline merges workflows, external CI, project.yml ci and ci.gates", async () => {
    const root = makeRepo({
      "package.json": { scripts: { test: "node --test" } },
      ".github/workflows/deploy.yml": "name: deploy\n",
      ".github/workflows/ci.yml": "name: legacy\n",
      ".github/workflows/hyperion-sync-cards.yml": "name: sync\n",
      ".gitlab-ci.yml": "stages: []\n",
      ".github/project.yml": 'ci:\n  provider: github-actions\n  policy: detect\n  stack: auto\n  existing:\n    - "build.yml"\n  hyperion:\n    security_scan: false\n  gates:\n    defaults:\n      lint: block\n',
    });
    const d = await detectPipeline(root);
    assert.deepEqual(d.workflows, ["ci.yml", "deploy.yml", "hyperion-sync-cards.yml"]);
    assert.deepEqual(d.classified, { hyperion: ["hyperion-sync-cards.yml"], product: ["deploy.yml"], legacy: ["ci.yml"] });
    assert.equal(d.config.provider, "gitlab-ci");
    assert.equal(d.config.stack, "node-npm");
    assert.equal(d.config.hyperion.security_scan, false);
    assert.equal(d.config.hyperion.cards_sync, true);
    assert.deepEqual(d.config.existing, ["build.yml", ".github/workflows/deploy.yml", ".github/workflows/ci.yml", ".gitlab-ci.yml"]);
    assert.equal(d.hasProductCi, true);
    assert.equal(d.config.gates.defaults.lint, "block");
    assert.equal(d.productCiGates.exists, false);
    assert.equal(d.productCiGates.apps, 1);
    assert.match(formatCiYamlBlock(d), /^ci:\n {2}provider: gitlab-ci\n {2}policy: detect\n {2}stack: node-npm\n {2}existing:\n {4}- "build.yml"/);
    assert.doesNotMatch(formatCiYamlBlock(d), /# gates:/);

    const empty = await detectPipeline(makeRepo());
    assert.equal(empty.config.provider, "github-actions");
    assert.equal(empty.config.stack, "unknown");
    assert.equal(empty.hasProductCi, false);
    assert.equal(empty.productCiGates, null);
    assert.match(formatCiYamlBlock(empty), /# gates: run \/pipeline/);
  });

  it("formatCiYamlBlock falls back to classified workflows when config.existing is empty", () => {
    const yaml = formatCiYamlBlock({
      config: { ...DEFAULT_CI_CONFIG, existing: [], hyperion: { ...DEFAULT_CI_CONFIG.hyperion, cards_sync_mode: "auto", product_ci: true } },
      hasProductCi: true,
      stack: "go",
      classified: { product: ["deploy.yml"], legacy: ["ci.yml"], hyperion: [] },
    });
    assert.match(yaml, / {2}existing:\n {4}- ".github\/workflows\/deploy.yml"\n {4}- ".github\/workflows\/ci.yml"/);
    assert.match(yaml, /product_ci: true/);
    assert.match(yaml, /cards_sync_mode: auto/);
  });
});

describe("buildPipelinePlan (more branches)", () => {
  const base = (overrides = {}, hyperion = {}) => ({
    config: { ...DEFAULT_CI_CONFIG, existing: [], hyperion: { ...DEFAULT_CI_CONFIG.hyperion, ...hyperion }, ...overrides },
    hasProductCi: false,
    classified: { legacy: [], product: [], hyperion: [] },
    stack: "node-npm",
    external: [],
  });

  it("warns about legacy workflows and uses the auto-reconcile reason", () => {
    const plan = buildPipelinePlan({
      ...base({}, { cards_sync_mode: "auto", kit_validation: true }),
      hasProductCi: true,
      classified: { legacy: ["ci.yml", "security.yml"], product: [], hyperion: [] },
    });
    assert.ok(plan.warnings.some((w) => /Legacy kit workflows found \(ci\.yml, security\.yml\)/.test(w)));
    assert.match(plan.actions.find((a) => a.template === "hyperion-sync-cards.yml").reason, /auto reconcile/);
    assert.ok(plan.actions.some((a) => a.template === "hyperion-validate.yml"));
  });

  it("ci.gates alongside existing product CI warns, and a generic product CI is replaced", () => {
    const withProduct = buildPipelinePlan({ ...base({ gates: { defaults: {} } }), hasProductCi: true });
    assert.ok(withProduct.warnings.some((w) => /runs in addition .*\(other workflows\)/.test(w) || /other workflows/.test(w)));
    assert.match(withProduct.actions.find((a) => a.render === "gates").reason, /\(0 app\(s\)\)/);

    const generic = buildPipelinePlan({
      ...base({ gates: { defaults: {} } }),
      classified: { legacy: [], product: [], hyperion: ["hyperion-product-ci.yml"] },
      productCiGates: { exists: true, currentHash: null, expectedHash: "x", noAutoRefresh: false, apps: 1 },
    });
    const replace = generic.actions.find((a) => a.replace);
    assert.match(replace.reason, /Replace generic product CI/);
    assert.ok(generic.warnings.some((w) => /--refresh-gates --yes/.test(w)));
  });

  it("hyperion-only policy plans a greenfield product CI", () => {
    const plan = buildPipelinePlan(base({ policy: "hyperion-only" }));
    assert.match(plan.actions.find((a) => a.template === "hyperion-product-ci.yml").reason, /Greenfield product CI for stack: node-npm/);
  });

  it("GitLab/Azure snippets are skipped when every Hyperion job is disabled", () => {
    const plan = buildPipelinePlan({
      ...base({ provider: "gitlab-ci" }, { cards_sync: false, kit_validation: false, security_scan: false }),
      external: [{ provider: "azure-pipelines", file: "azure-pipelines.yml" }],
    });
    assert.deepEqual(plan.actions, []);
  });
});

describe("render options and file audit", () => {
  it("readCardsSyncMode and resolvePipelineRenderOptions read project.yml", () => {
    const auto = makeRepo({ ".github/project.yml": "ci:\n  hyperion:\n    cards_sync_mode: \"auto\"\n" });
    assert.equal(readCardsSyncMode(auto), "auto");
    assert.equal(readCardsSyncMode(makeRepo()), "pull-forward");
    const opts = resolvePipelineRenderOptions(auto, { kitRootRel: "Kit\\" });
    assert.equal(opts.kitRootRel, "Kit");
    assert.equal(opts.defaultBranch, "main");
    assert.equal(opts.syncMode, "auto");
    assert.ok(Array.isArray(opts.i18n.languages));
    const nested = makeRepo({ ".github/project.yml": "kit:\n  root: Hyperion\n" });
    assert.equal(resolvePipelineRenderOptions(nested).kitRootRel, "Hyperion");
  });

  it("auditHyperionPipelineFiles flags outdated files, stale product CI and (optionally) missing sync workflows", async () => {
    const gatesYml = "ci:\n  gates:\n    defaults:\n      lint: block\n";
    const stale = makeRepo({
      "package.json": { scripts: { lint: "eslint ." } },
      ".github/project.yml": gatesYml,
      ".github/workflows/hyperion-sync-cards.yml": "on:\n  push:\n",
      ".github/workflows/hyperion-cards-pr-check.yml": "name: x\n",
      ".github/workflows/hyperion-cards-pr-recheck.yml": "name: x\n",
      ".github/workflows/hyperion-product-ci.yml": "name: generic\n",
      ".gitlab/hyperion-ci.yml": "stages: []\n",
      "hyperion-azure-pipelines.yml": "jobs: []\n",
    });
    const { renderOpts, findings } = await auditHyperionPipelineFiles(stale, { defaultBranch: "main" });
    assert.deepEqual(renderOpts, { kitRootRel: "", defaultBranch: "main", syncMode: "pull-forward" });
    assert.deepEqual(findings.map((f) => f.kind), [
      "github-sync-cards",
      "github-cards-pr-guard",
      "github-cards-pr-recheck",
      "gitlab-ci",
      "azure-pipelines",
      "github-product-ci-gates",
    ]);
    assert.deepEqual(findings.at(-1).issues, ["not_rendered_from_gates"]);

    const fresh = makeRepo({
      "package.json": { scripts: { lint: "eslint ." } },
      ".github/project.yml": gatesYml,
      ".github/workflows/hyperion-sync-cards.yml": renderSyncCardsWorkflow(),
      ".github/workflows/hyperion-cards-pr-check.yml": renderPrBoardGuardWorkflow(),
      ".github/workflows/hyperion-cards-pr-recheck.yml": renderPrRecheckWorkflow(),
      ".github/workflows/hyperion-product-ci.yml": "# hyperion:gates-hash 0000000000000000\nname: old\n",
      ".gitlab/hyperion-ci.yml": renderGitLabHyperionCi(),
      "hyperion-azure-pipelines.yml": renderAzureHyperionCi(),
    });
    const freshAudit = await auditHyperionPipelineFiles(fresh);
    assert.deepEqual(freshAudit.findings.map((f) => [f.kind, f.issues]), [["github-product-ci-gates", ["gates_changed"]]]);

    fs.writeFileSync(path.join(fresh, ".github/workflows/hyperion-product-ci.yml"), `# ${NO_AUTO_REFRESH_MARKER}\nname: pinned\n`);
    assert.deepEqual((await auditHyperionPipelineFiles(fresh)).findings, []);

    const state = await inspectProductCiGates(fresh, { defaults: { lint: "block" } });
    assert.equal(state.noAutoRefresh, true);
    assert.equal(state.currentHash, null);

    const missing = await auditHyperionPipelineFiles(makeRepo(), { expectSyncWorkflow: true, defaultBranch: "main" });
    assert.deepEqual(missing.findings.map((f) => [f.kind, f.issues[0]]), [
      ["github-sync-cards", "missing_file"],
      ["github-cards-pr-guard", "missing_file"],
      ["github-cards-pr-recheck", "missing_file"],
    ]);
  });
});
