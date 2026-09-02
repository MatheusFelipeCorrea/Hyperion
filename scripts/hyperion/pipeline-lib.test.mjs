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
});

describe("renderSyncCardsWorkflow", () => {
  it("includes main branch filter and concurrency for legacy layout", () => {
    const yaml = renderSyncCardsWorkflow();
    assert.match(yaml, /branches: \[main\]/);
    assert.match(yaml, /cancel-in-progress: true/);
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
