import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
