import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { workspaceRoot, pathExists, readTextIfExists } from "./lib.mjs";
import { resolveHyperionPaths } from "./paths.mjs";

export const HYPERION_PREFIX = "hyperion-";
export const WORKFLOWS_DIR = ".github/workflows";
export const TEMPLATES_DIR = path.join("scripts", "hyperion", "templates", "workflows");
export const CI_TEMPLATES_DIR = path.join("scripts", "hyperion", "templates", "ci");

export const HYPERION_WORKFLOWS = {
  syncCards: "hyperion-sync-cards.yml",
  cardsPrGuard: "hyperion-cards-pr-check.yml",
  cardsPrRecheck: "hyperion-cards-pr-recheck.yml",
  security: "hyperion-security.yml",
  validate: "hyperion-validate.yml",
  productCi: "hyperion-product-ci.yml",
};

export const LEGACY_WORKFLOWS = ["ci.yml", "sync-cards.yml", "security.yml"];

/** Detect origin default branch (main, master, …). Falls back to main. */
export function detectDefaultBranch(root = workspaceRoot) {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      encoding: "utf8",
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  } catch {
    /* no origin HEAD */
  }

  try {
    const ref = execSync("git symbolic-ref HEAD", {
      encoding: "utf8",
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = ref.match(/refs\/heads\/(.+)$/);
    if (match?.[1]) return match[1];
  } catch {
    /* detached or no git */
  }

  // Last resort: ask git directly whether main/master exist as branches.
  // (Reading .git/refs/heads/* directly would break in a worktree or
  // submodule, where .git is a file pointing elsewhere, not a directory.)
  for (const candidate of ["main", "master"]) {
    try {
      execSync(`git rev-parse --verify --quiet ${candidate}`, {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return candidate;
    } catch {
      /* branch doesn't exist */
    }
  }

  return "main";
}

export function normalizeKitRootRel(kitRootRel) {
  return String(kitRootRel || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

/**
 * Marker a maintainer can put anywhere in hyperion-sync-cards.yml to opt the
 * file out of the "outdated, refresh me" audit entirely — e.g. this kit's
 * own repo deliberately drops the push trigger (PR #69) because it has no
 * real GitHub Project to sync to. Without this, hyperion:doctor's own
 * suggested fix (pipeline-apply --refresh-sync --yes) would silently
 * overwrite that deliberate customization back to the generic template.
 */
export const NO_AUTO_REFRESH_MARKER = "hyperion:no-auto-refresh";

/**
 * Audit hyperion-sync-cards.yml for branch filter, concurrency, and nested paths.
 * @returns {{ ok: boolean, issues: string[], missing: string[] }}
 */
export function auditSyncCardsWorkflow(content, { kitRootRel = "" } = {}) {
  const text = String(content || "");
  const issues = [];
  const missing = [];
  const kit = normalizeKitRootRel(kitRootRel);
  const prefix = kit ? `${kit}/` : "";

  if (!text.trim()) {
    return { ok: false, issues: ["missing_file"], missing: ["file"] };
  }

  if (text.includes(NO_AUTO_REFRESH_MARKER)) {
    return { ok: true, issues: [], missing: [] };
  }

  if (!/^\s*on:/m.test(text)) missing.push("on");
  if (!/branches:\s*\[/m.test(text)) {
    issues.push("missing_push_branch_filter");
    missing.push("push.branches");
  }
  if (!/^concurrency:/m.test(text)) {
    issues.push("missing_concurrency_block");
    missing.push("concurrency");
  }
  if (!/cancel-in-progress:\s*false/m.test(text)) {
    issues.push("missing_cancel_in_progress");
    missing.push("concurrency.cancel-in-progress");
  }
  if (!/ci-sync\.mjs/m.test(text)) {
    issues.push("missing_ci_pull_push");
    missing.push("scripts/cards-sync/ci-sync.mjs");
  }
  if (!/CARDS_CI_REQUIRE_PROJECT/m.test(text)) {
    issues.push("missing_ci_project_requirement");
    missing.push("env.CARDS_CI_REQUIRE_PROJECT");
  }
  if (!/CARDS_CI_STRICT_GIT/m.test(text)) {
    issues.push("missing_strict_git");
    missing.push("env.CARDS_CI_STRICT_GIT");
  }

  const cardsPath = `"${prefix}.github/cards/`;
  if (!text.includes(cardsPath)) {
    issues.push("cards_paths_mismatch");
    missing.push("paths.cards");
  }

  if (kit && !/working-directory:\s*/m.test(text)) {
    issues.push("missing_working_directory");
    missing.push("job.defaults.run.working-directory");
  }
  if (!kit && /working-directory:/m.test(text)) {
    issues.push("unexpected_working_directory");
  }

  return { ok: issues.length === 0, issues, missing };
}

/** Audit GitLab Hyperion CI snippet for default-branch cards rules and resource_group. */
export function auditGitLabHyperionCi(content, { kitRootRel = "" } = {}) {
  const text = String(content || "");
  const issues = [];
  const kit = normalizeKitRootRel(kitRootRel);
  const prefix = kit ? `${kit}/` : "";

  if (!text.trim()) return { ok: false, issues: ["missing_file"] };

  if (!/resource_group:\s*hyperion-cards-sync/m.test(text)) {
    issues.push("missing_resource_group");
  }
  if (!/\$CI_DEFAULT_BRANCH/m.test(text)) {
    issues.push("missing_default_branch_rule");
  }
  if (!text.includes(`${prefix}.github/cards/`)) {
    issues.push("cards_paths_mismatch");
  }
  if (kit && !/\bcd\s+[^\n]+/m.test(text)) {
    issues.push("missing_kit_cd");
  }

  return { ok: issues.length === 0, issues };
}

/** Audit Azure Hyperion template for default-branch cards condition. */
export function auditAzureHyperionCi(content) {
  const text = String(content || "");
  const issues = [];

  if (!text.trim()) return { ok: false, issues: ["missing_file"] };

  if (!/name:\s*defaultBranch/m.test(text)) {
    issues.push("missing_default_branch_parameter");
  }
  if (!/Build\.SourceBranch/m.test(text)) {
    issues.push("missing_branch_condition");
  }
  if (!/parameters\.defaultBranch/m.test(text)) {
    issues.push("missing_default_branch_parameter_ref");
  }

  return { ok: issues.length === 0, issues };
}

export const DEFAULT_CI_CONFIG = {
  provider: "github-actions",
  policy: "detect",
  stack: "auto",
  existing: [],
  hyperion: {
    cards_sync: true,
    kit_validation: false,
    security_scan: true,
    product_ci: "auto",
  },
};

/**
 * Render hyperion-sync-cards workflow YAML for legacy (kit at repo root) or nested kit.root layout.
 * @param {{ kitRootRel?: string, defaultBranch?: string }} opts
 */
export function renderSyncCardsWorkflow({ kitRootRel = "", defaultBranch = "main" } = {}) {
  const prefix = kitRootRel ? `${String(kitRootRel).replace(/\\/g, "/").replace(/\/+$/, "")}/` : "";
  const wdBlock = kitRootRel
    ? `\n    defaults:\n      run:\n        working-directory: ${kitRootRel}`
    : "";

  return `name: Hyperion — Sync Cards

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Run without persisting changes (set to false for a real sync)"
        required: false
        default: "true"
      sync_direction:
        description: "pull-forward | forward-only | reverse"
        required: false
        default: "pull-forward"
  push:
    branches: [${defaultBranch}]
    paths:
      - "${prefix}.github/cards/**/*.md"
      - "${prefix}.github/cards/config/projects-map.json"
      - "${prefix}scripts/cards-sync/**"

concurrency:
  group: hyperion-sync-cards-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read
  issues: write
  repository-projects: write

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 30${wdBlock}
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: "24"

      - name: Pull → verify → push (main CI)
        if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && github.event.inputs.sync_direction != 'reverse' && github.event.inputs.sync_direction != 'forward-only')
        env:
          GITHUB_TOKEN: \${{ github.token }}
          PROJECT_SYNC_TOKEN: \${{ secrets.PROJECT_SYNC_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          GITHUB_EVENT_BEFORE: \${{ github.event.before }}
          CREATE_MISSING_LABELS: "true"
          DRY_RUN: \${{ github.event.inputs.dry_run || 'false' }}
          CARDS_CI_REQUIRE_PROJECT: "true"
          CARDS_CI_STRICT_GIT: "true"
        run: node scripts/cards-sync/ci-sync.mjs

      - name: Forward sync only
        if: github.event_name == 'workflow_dispatch' && github.event.inputs.sync_direction == 'forward-only'
        env:
          GITHUB_TOKEN: \${{ github.token }}
          PROJECT_SYNC_TOKEN: \${{ secrets.PROJECT_SYNC_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          CREATE_MISSING_LABELS: "true"
          DRY_RUN: \${{ github.event.inputs.dry_run || 'false' }}
          CARDS_CI_SKIP_REVERSE: "true"
          CARDS_CI_SKIP_BOARD_GUARD: "true"
        run: node scripts/cards-sync/ci-sync.mjs

      - name: Reverse sync only
        if: github.event_name == 'workflow_dispatch' && github.event.inputs.sync_direction == 'reverse'
        env:
          GITHUB_TOKEN: \${{ github.token }}
          PROJECT_SYNC_TOKEN: \${{ secrets.PROJECT_SYNC_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          DRY_RUN: \${{ github.event.inputs.dry_run || 'false' }}
        run: node scripts/cards-sync/sync.mjs --reverse
`;
}

/**
 * Render PR board guard workflow — blocks merge when board diverges from PR branch.
 * @param {{ kitRootRel?: string, defaultBranch?: string }} opts
 */
export function renderPrBoardGuardWorkflow({ kitRootRel = "", defaultBranch = "main" } = {}) {
  const prefix = kitRootRel ? `${String(kitRootRel).replace(/\\/g, "/").replace(/\/+$/, "")}/` : "";
  const wdBlock = kitRootRel
    ? `\n    defaults:\n      run:\n        working-directory: ${kitRootRel}`
    : "";

  return `name: Hyperion — Cards PR Board Guard

# Directional board guard — blocks external drift, allows forward-pending PR edits.
# Enable Merge Queue + mark board-guard as required check in branch rulesets.

on:
  pull_request:
    branches: [${defaultBranch}]
    paths:
      - "${prefix}.github/cards/**/*.md"
      - "${prefix}.github/cards/config/projects-map.json"
      - "${prefix}scripts/cards-sync/**"
  merge_group:
    branches: [${defaultBranch}]

permissions:
  contents: read
  issues: read
  repository-projects: read

jobs:
  board-guard:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: github.event_name == 'merge_group' || github.event.pull_request.head.repo.full_name == github.repository${wdBlock}
    steps:
      - name: Checkout PR / merge-group head
        uses: actions/checkout@v5
        with:
          ref: \${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}
          fetch-depth: 0

      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: "24"

      - name: Directional board drift guard
        env:
          GITHUB_TOKEN: \${{ github.token }}
          PROJECT_SYNC_TOKEN: \${{ secrets.PROJECT_SYNC_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          GITHUB_BASE_SHA: \${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.pull_request.base.sha }}
          CARDS_CI_REQUIRE_PROJECT: "true"
          CARDS_CI_STRICT_GIT: "true"
        run: node scripts/cards-sync/pr-board-guard.mjs

  board-guard-fork:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository${wdBlock}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "24"
      - name: Validate cards only (fork — no board token)
        run: node scripts/cards-sync/validate.mjs
`;
}

/** Render scheduled PR recheck workflow (cron + repository_dispatch). */
export function renderPrRecheckWorkflow({ kitRootRel = "" } = {}) {
  const wdBlock = kitRootRel
    ? `\n    defaults:\n      run:\n        working-directory: ${kitRootRel}`
    : "";

  return `name: Hyperion — Cards PR Recheck

on:
  schedule:
    - cron: "*/30 * * * *"
  repository_dispatch:
    types: [hyperion-board-changed]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read
  checks: write
  issues: read
  repository-projects: read

jobs:
  list-open-prs:
    runs-on: ubuntu-latest
    outputs:
      matrix: \${{ steps.set-matrix.outputs.matrix }}
    steps:
      - uses: actions/github-script@v7
        id: set-matrix
        with:
          script: |
            const { owner, repo } = context.repo;
            const { data: pulls } = await github.rest.pulls.list({ owner, repo, state: "open", base: "main", per_page: 100 });
            const matrix = pulls.filter((pr) => pr.head?.repo?.full_name === \`\${owner}/\${repo}\`).map((pr) => ({
              number: pr.number, head_sha: pr.head.sha, base_sha: pr.base.sha, head_ref: pr.head.ref,
            }));
            core.setOutput("matrix", JSON.stringify(matrix.length ? matrix : [{ skip: true }]));

  recheck:
    needs: list-open-prs
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      max-parallel: 5
      matrix:
        include: \${{ fromJson(needs.list-open-prs.outputs.matrix) }}
    steps:
      - if: matrix.skip != true
        uses: actions/checkout@v5
        with:
          ref: \${{ matrix.head_sha }}
          fetch-depth: 0
      - if: matrix.skip != true
        uses: actions/setup-node@v5
        with:
          node-version: "24"
      - if: matrix.skip != true
        env:
          GITHUB_TOKEN: \${{ github.token }}
          PROJECT_SYNC_TOKEN: \${{ secrets.PROJECT_SYNC_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          GITHUB_BASE_SHA: \${{ matrix.base_sha }}
          CARDS_PR_HEAD_SHA: \${{ matrix.head_sha }}
          CARDS_CI_REQUIRE_PROJECT: "true"
          CARDS_CI_STRICT_GIT: "true"
          CARDS_PR_CHECK_NAME: board-guard
        run: node scripts/cards-sync/report-pr-guard-check.mjs --head-sha "\${{ matrix.head_sha }}" --base-sha "\${{ matrix.base_sha }}"
`;
}

/** Audit hyperion-cards-pr-recheck.yml */
export function auditPrRecheckWorkflow(content) {
  const text = String(content || "");
  const issues = [];
  if (!text.trim()) return { ok: false, issues: ["missing_file"] };
  if (!/schedule:/m.test(text)) issues.push("missing_schedule");
  if (!/repository_dispatch:/m.test(text)) issues.push("missing_repository_dispatch");
  if (!/report-pr-guard-check\.mjs/m.test(text)) issues.push("missing_report_script");
  if (!/hyperion-board-changed/m.test(text)) issues.push("missing_dispatch_type");
  return { ok: issues.length === 0, issues };
}

/** @deprecated */
export function renderPrBoardGuardForkWorkflow({ kitRootRel = "" } = {}) {
  const wdBlock = kitRootRel
    ? `\n    defaults:\n      run:\n        working-directory: ${kitRootRel}`
    : "";
  return `  board-guard-fork:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    if: github.event.pull_request.head.repo.full_name != github.repository${wdBlock}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "24"
      - name: Validate cards only (fork — no board token)
        run: node scripts/cards-sync/validate.mjs
`;
}

/** @deprecated */
export function appendForkGuardJob(workflowYaml) {
  if (workflowYaml.includes("board-guard-fork:")) return workflowYaml;
  return `${workflowYaml.trimEnd()}\n\n${renderPrBoardGuardForkWorkflow().trimStart()}\n`;
}

/** Audit hyperion-cards-pr-check.yml for pull_request trigger and pr-board-guard.mjs. */
export function auditPrBoardGuardWorkflow(content, { kitRootRel = "" } = {}) {
  const text = String(content || "");
  const issues = [];
  const kit = normalizeKitRootRel(kitRootRel);
  const prefix = kit ? `${kit}/` : "";

  if (!text.trim()) return { ok: false, issues: ["missing_file"] };

  if (!/pull_request:/m.test(text)) issues.push("missing_pull_request_trigger");
  if (!/pr-board-guard\.mjs/m.test(text)) issues.push("missing_pr_board_guard_script");
  if (!/merge_group:/m.test(text)) issues.push("missing_merge_group_trigger");
  if (!/CARDS_CI_STRICT_GIT/m.test(text)) issues.push("missing_strict_git");
  if (!/GITHUB_BASE_SHA/m.test(text)) issues.push("missing_pr_base_sha");
  if (!/CARDS_CI_REQUIRE_PROJECT/m.test(text)) issues.push("missing_ci_project_requirement");
  if (!/board-guard-fork:/m.test(text)) issues.push("missing_fork_validate_job");

  const cardsPath = `"${prefix}.github/cards/`;
  if (!text.includes(cardsPath)) issues.push("cards_paths_mismatch");

  if (kit && !/working-directory:\s*/m.test(text)) issues.push("missing_working_directory");

  return { ok: issues.length === 0, issues };
}

/**
 * GitLab CI include snippet — cards job runs on default branch only with resource_group lock.
 * Uses ci-sync.mjs (pull → verify → push). Configure board tokens in CI variables.
 */
export function renderGitLabHyperionCi({ kitRootRel = "", defaultBranch = "main" } = {}) {
  const kit = normalizeKitRootRel(kitRootRel);
  const prefix = kit ? `${kit}/` : "";
  const cdLine = kit ? `\n    - cd ${kit}` : "";

  return `# Hyperion jobs for GitLab CI — include from .gitlab-ci.yml:
#
#   include:
#     - local: .gitlab/hyperion-ci.yml
#
# Requires Node 20+ and Hyperion scripts (${kit ? `under ${kit}/` : "at repo root"}).
# Cards sync on default branch (${defaultBranch}): pull → verify → push via ci-sync.mjs.
# Set CARDS_CI_REQUIRE_PROJECT=true for GitHub Projects V2 when backend is github.

stages:
  - hyperion

.hyperion_node:
  image: node:22
  before_script:
    - node -v${cdLine}

hyperion-validate:
  extends: .hyperion_node
  stage: hyperion
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - npm run docs:check
    - npm run skills:validate
    - npm run hyperion:check-rules
    - npm run hyperion:skills-eval
    - npm test
  allow_failure: false

hyperion-cards:
  extends: .hyperion_node
  stage: hyperion
  resource_group: hyperion-cards-sync
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      changes:
        - ${prefix}.github/cards/**/*
        - ${prefix}.github/cards/config/projects-map.json
        - ${prefix}scripts/cards-sync/**
    - when: never
  script:
    - node scripts/cards-sync/ci-sync.mjs

hyperion-cards-pr-guard:
  extends: .hyperion_node
  stage: hyperion
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        - ${prefix}.github/cards/**/*
        - ${prefix}.github/cards/config/projects-map.json
        - ${prefix}scripts/cards-sync/**
    - when: never
  script:
    - node scripts/cards-sync/pr-board-guard.mjs
  allow_failure: false

hyperion-security:
  extends: .hyperion_node
  stage: hyperion
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
    - if: $CI_PIPELINE_SOURCE == "web"
  script:
    - |
      if [ -f package.json ]; then
        npm audit --audit-level=high
      fi
    - |
      if [ -f requirements.txt ] || [ -f pyproject.toml ]; then
        pip install pip-audit
        pip-audit || pip-audit -r requirements.txt
      fi
    - |
      if [ -f package.json ]; then
        npx --yes license-checker@25.0.1 --excludePrivatePackages --summary \
          --failOn "GPL-1.0;GPL-2.0;GPL-3.0;AGPL-1.0;AGPL-3.0;LGPL-2.0;LGPL-2.1;LGPL-3.0;UNLICENSED"
      fi
  allow_failure: false
`;
}

/**
 * Azure Pipelines job template — cards job runs on default branch only.
 */
export function renderAzureHyperionCi({ kitRootRel = "", defaultBranch = "main" } = {}) {
  const kit = normalizeKitRootRel(kitRootRel);
  const cdPrefix = kit ? `cd ${kit} && ` : "";

  return `# Hyperion jobs for Azure Pipelines — include from azure-pipelines.yml:
#
#   stages:
#     - stage: Hyperion
#       jobs:
#         - template: hyperion-azure-pipelines.yml
#
# Cards sync via ci-sync.mjs (pull → verify → push). Configure board tokens in pipeline variables.
# HyperionCards runs on refs/heads/${defaultBranch} only.

parameters:
  - name: runValidate
    type: boolean
    default: true
  - name: runCards
    type: boolean
    default: true
  - name: runSecurity
    type: boolean
    default: false
  - name: defaultBranch
    type: string
    default: ${defaultBranch}

jobs:
  - job: HyperionValidate
    displayName: Hyperion kit validation
    condition: eq(\${{ parameters.runValidate }}, true)
    pool:
      vmImage: ubuntu-latest
    steps:
      - task: NodeTool@0
        inputs:
          versionSpec: "22.x"
      - script: |
          ${cdPrefix}npm run docs:check
          ${cdPrefix}npm run skills:validate
          ${cdPrefix}npm run hyperion:check-rules
          ${cdPrefix}npm run hyperion:skills-eval
          ${cdPrefix}npm test
        displayName: Validate Hyperion kit

  - job: HyperionCards
    displayName: Hyperion cards CI sync
    condition: and(eq(\${{ parameters.runCards }}, true), eq(variables['Build.SourceBranch'], 'refs/heads/\${{ parameters.defaultBranch }}'))
    pool:
      vmImage: ubuntu-latest
    steps:
      - task: NodeTool@0
        inputs:
          versionSpec: "22.x"
      - script: |
          ${cdPrefix}node scripts/cards-sync/ci-sync.mjs
        displayName: Cards CI sync pull→verify→push (${defaultBranch} only)

  - job: HyperionCardsPrGuard
    displayName: Hyperion cards PR board guard
    condition: and(eq(\${{ parameters.runCards }}, true), eq(variables['Build.Reason'], 'PullRequest'))
    pool:
      vmImage: ubuntu-latest
    steps:
      - task: NodeTool@0
        inputs:
          versionSpec: "22.x"
      - script: |
          ${cdPrefix}node scripts/cards-sync/pr-board-guard.mjs
        displayName: Directional board drift guard (PR)
        env:
          CARDS_CI_REQUIRE_PROJECT: "true"

  - job: HyperionSecurity
    displayName: Hyperion security scan
    condition: eq(\${{ parameters.runSecurity }}, true)
    pool:
      vmImage: ubuntu-latest
    steps:
      - task: NodeTool@0
        inputs:
          versionSpec: "22.x"
      - script: |
          if [ -f package.json ]; then ${cdPrefix}npm audit --audit-level=high; fi
        displayName: npm audit (high+)
`;
}

const PROVIDER_MARKERS = [
  { provider: "gitlab-ci", files: [".gitlab-ci.yml"] },
  { provider: "azure-pipelines", files: ["azure-pipelines.yml", "azure-pipelines.yaml"] },
  { provider: "circleci", files: [".circleci/config.yml"] },
  { provider: "jenkins", files: ["Jenkinsfile"] },
  { provider: "bitbucket", files: ["bitbucket-pipelines.yml"] },
];

export function parseSimpleYamlBlock(text, key) {
  const keyRe = new RegExp(`^(${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}):\\s*$|^(${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}):\\s+`);
  const lines = text.split(/\r?\n/);
  let start = -1;
  let baseIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i])) {
      start = i;
      baseIndent = (lines[i].match(/^(\s*)/) || ["", ""])[1].length;
      break;
    }
  }
  if (start === -1) return null;

  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    const indent = (line.match(/^(\s*)/) || ["", ""])[1].length;
    if (indent <= baseIndent) break;
    out.push(line);
  }
  return out.join("\n");
}

export function readCiFromProjectYml(text) {
  if (!text) return null;
  const block = parseSimpleYamlBlock(text, "ci");
  if (!block) return null;

  const cfg = structuredClone(DEFAULT_CI_CONFIG);
  const provider = block.match(/^  provider:\s*(.+)$/m);
  const policy = block.match(/^  policy:\s*(.+)$/m);
  const stack = block.match(/^  stack:\s*(.+)$/m);
  if (provider) cfg.provider = provider[1].trim();
  if (policy) cfg.policy = policy[1].trim();
  if (stack) cfg.stack = stack[1].trim();

  const hyperionMatch = block.match(/^  hyperion:\s*\n((?:    .+\n?)*)/m);
  if (hyperionMatch) {
    const hyperionBlock = hyperionMatch[1];
    for (const [k, yamlKey] of [
      ["cards_sync", "cards_sync"],
      ["kit_validation", "kit_validation"],
      ["security_scan", "security_scan"],
    ]) {
      const m = hyperionBlock.match(new RegExp(`^    ${yamlKey}:\\s*(.+)$`, "m"));
      if (m) cfg.hyperion[k] = m[1].trim() === "true";
    }
    const pci = hyperionBlock.match(/^    product_ci:\s*(.+)$/m);
    if (pci) cfg.hyperion.product_ci = pci[1].trim();
  }

  const existing = [];
  const existingBlock = block.match(/^  existing:\s*\n((?:    - .+\n?)*)/m);
  if (existingBlock) {
    for (const line of existingBlock[1].split("\n")) {
      const m = line.match(/^    - "?(.+?)"?\s*$/);
      if (m) existing.push(m[1]);
    }
  }
  if (existing.length) cfg.existing = existing;

  return cfg;
}

export async function listGithubWorkflows(root = workspaceRoot) {
  const dir = path.join(root, WORKFLOWS_DIR);
  if (!(await pathExists(dir))) return [];
  const names = await fs.readdir(dir);
  return names.filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort();
}

export function classifyWorkflows(workflows) {
  const hyperion = [];
  const product = [];
  const legacy = [];

  for (const name of workflows) {
    if (LEGACY_WORKFLOWS.includes(name)) legacy.push(name);
    else if (name.startsWith(HYPERION_PREFIX)) hyperion.push(name);
    else product.push(name);
  }

  return { hyperion, product, legacy };
}

export async function detectExternalProviders(root = workspaceRoot) {
  const found = [];
  for (const { provider, files } of PROVIDER_MARKERS) {
    for (const file of files) {
      if (await pathExists(path.join(root, file))) found.push({ provider, file });
    }
  }
  return found;
}

export async function detectStack(root = workspaceRoot) {
  if (await pathExists(path.join(root, "bun.lockb")) || (await pathExists(path.join(root, "bun.lock")))) {
    return "node-bun";
  }
  if (await pathExists(path.join(root, "package.json"))) {
    if (await pathExists(path.join(root, "pnpm-lock.yaml"))) return "node-pnpm";
    if (await pathExists(path.join(root, "yarn.lock"))) return "node-yarn";
    return "node-npm";
  }
  if (await pathExists(path.join(root, "pyproject.toml")) || (await pathExists(path.join(root, "requirements.txt")))) {
    return "python";
  }
  if (await pathExists(path.join(root, "go.mod"))) return "go";
  if (await pathExists(path.join(root, "Cargo.toml"))) return "rust";
  if (await pathExists(path.join(root, "pom.xml"))) return "java-maven";
  if (
    (await pathExists(path.join(root, "build.gradle"))) ||
    (await pathExists(path.join(root, "build.gradle.kts"))) ||
    (await pathExists(path.join(root, "settings.gradle"))) ||
    (await pathExists(path.join(root, "settings.gradle.kts")))
  ) {
    return "java-gradle";
  }
  if (await pathExists(path.join(root, "composer.json"))) return "php";
  if (await pathExists(path.join(root, "Gemfile"))) return "ruby";
  if (await pathExists(path.join(root, "Directory.Build.props"))) return "dotnet";
  try {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(root);
    if (names.some((n) => n.endsWith(".sln") || n.endsWith(".csproj"))) return "dotnet";
  } catch {
    /* ignore */
  }
  if (await pathExists(path.join(root, "Dockerfile")) || (await pathExists(path.join(root, "docker-compose.yml")))) {
    return "docker";
  }
  return "unknown";
}

export async function detectPipeline(root = workspaceRoot) {
  const workflows = await listGithubWorkflows(root);
  const classified = classifyWorkflows(workflows);
  const external = await detectExternalProviders(root);
  const stack = await detectStack(root);

  let provider = "none";
  if (workflows.length > 0 || classified.product.length > 0) provider = "github-actions";
  if (external.length > 0) provider = external[0].provider;

  const projectYmlPath = path.join(root, ".github", "project.yml");
  const projectText = await readTextIfExists(projectYmlPath);
  const configured = readCiFromProjectYml(projectText);
  const config = configured ? { ...DEFAULT_CI_CONFIG, ...configured, hyperion: { ...DEFAULT_CI_CONFIG.hyperion, ...configured.hyperion } } : structuredClone(DEFAULT_CI_CONFIG);

  if (provider !== "none") config.provider = provider;
  if (config.stack === "auto") config.stack = stack;

  const productPaths = [
    ...classified.product.map((n) => `${WORKFLOWS_DIR}/${n}`),
    ...classified.legacy.map((n) => `${WORKFLOWS_DIR}/${n}`),
    ...external.map((e) => e.file),
  ];
  if (productPaths.length) config.existing = [...new Set([...config.existing, ...productPaths])];

  const hasProductCi = classified.product.length > 0 || classified.legacy.length > 0 || external.length > 0;

  return {
    workflows,
    classified,
    external,
    stack,
    config,
    hasProductCi,
    projectYmlPath,
  };
}

export function buildPipelinePlan(detection) {
  const { config, hasProductCi, classified, stack, external } = detection;
  const plan = {
    policy: config.policy,
    provider: config.provider,
    stack,
    hasProductCi,
    actions: [],
    skips: [],
    warnings: [],
  };

  // Hyperion-owned workflow files already on disk (from listGithubWorkflows)
  // route to `skips`, same as the product-CI branch below already does —
  // otherwise the plan claims it will create files that already exist.
  const existingHyperionFiles = new Set(classified.hyperion || []);
  function planWorkflowAction(templateKey, reason) {
    const filename = HYPERION_WORKFLOWS[templateKey];
    if (existingHyperionFiles.has(filename)) {
      plan.skips.push(`${WORKFLOWS_DIR}/${filename} already exists — not overwritten.`);
      return;
    }
    plan.actions.push({
      file: `${WORKFLOWS_DIR}/${filename}`,
      template: filename,
      templateDir: "workflows",
      reason,
    });
  }

  if (config.policy === "skip") {
    plan.skips.push("All Hyperion workflow writes skipped (ci.policy=skip).");
    return plan;
  }

  if (classified.legacy.length > 0) {
    plan.warnings.push(
      `Legacy kit workflows found (${classified.legacy.join(", ")}) — run npm run hyperion:pipeline-apply to migrate to hyperion-* names.`
    );
  }

  const h = config.hyperion;
  const externalProviders = new Set((external || []).map((e) => e.provider));
  const provider = config.provider || "";
  const isGitLab = provider === "gitlab-ci" || externalProviders.has("gitlab-ci");
  const isAzure = provider === "azure-pipelines" || externalProviders.has("azure-pipelines");
  const useGithubActions =
    !isGitLab && !isAzure && (provider === "github-actions" || provider === "none" || !provider);

  if (useGithubActions) {
    if (h.cards_sync) {
      planWorkflowAction("syncCards", "Cards sync on push to main (.github/cards/ or nested kit.root paths)");
      planWorkflowAction("cardsPrGuard", "PR directional board guard + merge queue support");
      planWorkflowAction("cardsPrRecheck", "Scheduled PR recheck + repository_dispatch on board changes");
    }

    if (h.security_scan) {
      planWorkflowAction("security", "Optional security scan (npm audit, pip-audit, trufflehog)");
    }

    if (h.kit_validation) {
      planWorkflowAction("validate", "Hyperion kit validation (docs, skills, runtime rules, cards tests)");
    }

    const wantProductCi =
      h.product_ci === true || (h.product_ci === "auto" && !hasProductCi && config.policy !== "merge");
    // hasProductCi only looks at non-hyperion-prefixed workflows (see
    // detectPipeline) — it doesn't know hyperion-product-ci.yml itself might
    // already be on disk from a prior apply, so check that separately too.
    const productCiExists = existingHyperionFiles.has(HYPERION_WORKFLOWS.productCi);

    if (productCiExists && (wantProductCi || hasProductCi)) {
      plan.skips.push(`${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.productCi} already exists — not overwritten.`);
    } else if (wantProductCi && config.policy === "hyperion-only") {
      plan.actions.push({
        file: `${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.productCi}`,
        template: HYPERION_WORKFLOWS.productCi,
        templateDir: "workflows",
        reason: `Greenfield product CI for stack: ${stack}`,
      });
    } else if (wantProductCi && config.policy === "detect" && !hasProductCi) {
      plan.actions.push({
        file: `${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.productCi}`,
        template: HYPERION_WORKFLOWS.productCi,
        templateDir: "workflows",
        reason: `No product CI detected — generating minimal pipeline for ${stack}`,
      });
    } else if (hasProductCi && config.policy === "detect") {
      plan.skips.push("Product CI already exists — hyperion-product-ci.yml not written (ci.policy=detect).");
    }
  }

  // Native include snippets for GitLab / Azure (never overwrite product CI files)
  if (isGitLab && (h.cards_sync || h.kit_validation || h.security_scan)) {
    plan.actions.push({
      file: ".gitlab/hyperion-ci.yml",
      template: "gitlab-hyperion.yml",
      templateDir: "ci",
      reason: "GitLab CI include snippet for Hyperion jobs (merge into .gitlab-ci.yml)",
    });
    plan.warnings.push("GitLab: add `include: - local: .gitlab/hyperion-ci.yml` to .gitlab-ci.yml — see pipeline-merge.md");
  }

  if (isAzure && (h.cards_sync || h.kit_validation || h.security_scan)) {
    plan.actions.push({
      file: "hyperion-azure-pipelines.yml",
      template: "azure-pipelines-hyperion.yml",
      templateDir: "ci",
      reason: "Azure Pipelines job template for Hyperion (reference from azure-pipelines.yml)",
    });
    plan.warnings.push("Azure: reference hyperion-azure-pipelines.yml from your pipeline — see pipeline-merge.md");
  }

  if (config.policy === "merge") {
    plan.skips.push("Merge mode — Hyperion include snippets may still be written; product CI is never overwritten.");
    plan.warnings.push("See .github/docs/integration/pipeline-merge.md for injection snippets.");
  }

  return plan;
}

export function formatCiYamlBlock(detection) {
  const { config, hasProductCi, stack, classified } = detection;
  const existing = config.existing.length
    ? config.existing
    : [...classified.product, ...classified.legacy].map((n) => `${WORKFLOWS_DIR}/${n}`);

  const lines = [
    "ci:",
    `  provider: ${config.provider}`,
    `  policy: ${config.policy}`,
    `  stack: ${stack}`,
  ];

  if (existing.length) {
    lines.push("  existing:");
    for (const p of existing) lines.push(`    - "${p}"`);
  }

  lines.push("  hyperion:");
  lines.push(`    cards_sync: ${config.hyperion.cards_sync}`);
  lines.push(`    kit_validation: ${config.hyperion.kit_validation}`);
  lines.push(`    security_scan: ${config.hyperion.security_scan}`);
  lines.push(`    product_ci: ${config.hyperion.product_ci}`);

  return lines.join("\n");
}

/** Shared render options for sync workflow and CI snippets. */
export function resolvePipelineRenderOptions(root = workspaceRoot, { kitRootRel = null } = {}) {
  const kit =
    kitRootRel !== null ? normalizeKitRootRel(kitRootRel) : normalizeKitRootRel(resolveHyperionPaths(root).kitRootRel);
  return {
    kitRootRel: kit,
    defaultBranch: detectDefaultBranch(root),
  };
}

export async function auditHyperionPipelineFiles(root = workspaceRoot, options = {}) {
  const paths = resolveHyperionPaths(root);
  const renderOpts = {
    kitRootRel: paths.kitRootRel || "",
    defaultBranch: options.defaultBranch || detectDefaultBranch(root),
  };

  const findings = [];

  const syncRel = `${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.syncCards}`;
  const syncAbs = path.join(root, syncRel);
  const syncText = await readTextIfExists(syncAbs);
  if (syncText) {
    const audit = auditSyncCardsWorkflow(syncText, renderOpts);
    if (!audit.ok) {
      findings.push({
        file: syncRel,
        kind: "github-sync-cards",
        issues: audit.issues,
        fix: "npm run hyperion:pipeline-apply -- --refresh-sync --yes",
      });
    }
  } else if (options.expectSyncWorkflow) {
    findings.push({
      file: syncRel,
      kind: "github-sync-cards",
      issues: ["missing_file"],
      fix: "npm run hyperion:pipeline-apply -- --yes",
    });
  }

  const prGuardRel = `${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.cardsPrGuard}`;
  const prGuardText = await readTextIfExists(path.join(root, prGuardRel));
  if (prGuardText) {
    const audit = auditPrBoardGuardWorkflow(prGuardText, renderOpts);
    if (!audit.ok) {
      findings.push({
        file: prGuardRel,
        kind: "github-cards-pr-guard",
        issues: audit.issues,
        fix: "npm run hyperion:pipeline-apply -- --refresh-sync --yes",
      });
    }
  } else if (options.expectSyncWorkflow) {
    findings.push({
      file: prGuardRel,
      kind: "github-cards-pr-guard",
      issues: ["missing_file"],
      fix: "npm run hyperion:pipeline-apply -- --yes",
    });
  }

  const prRecheckRel = `${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.cardsPrRecheck}`;
  const prRecheckText = await readTextIfExists(path.join(root, prRecheckRel));
  if (prRecheckText) {
    const audit = auditPrRecheckWorkflow(prRecheckText);
    if (!audit.ok) {
      findings.push({
        file: prRecheckRel,
        kind: "github-cards-pr-recheck",
        issues: audit.issues,
        fix: "npm run hyperion:pipeline-apply -- --refresh-sync --yes",
      });
    }
  } else if (options.expectSyncWorkflow) {
    findings.push({
      file: prRecheckRel,
      kind: "github-cards-pr-recheck",
      issues: ["missing_file"],
      fix: "npm run hyperion:pipeline-apply -- --yes",
    });
  }

  const gitlabRel = ".gitlab/hyperion-ci.yml";
  const gitlabText = await readTextIfExists(path.join(root, gitlabRel));
  if (gitlabText) {
    const audit = auditGitLabHyperionCi(gitlabText, renderOpts);
    if (!audit.ok) {
      findings.push({
        file: gitlabRel,
        kind: "gitlab-ci",
        issues: audit.issues,
        fix: "npm run hyperion:pipeline-apply -- --refresh-sync --yes",
      });
    }
  }

  const azureRel = "hyperion-azure-pipelines.yml";
  const azureText = await readTextIfExists(path.join(root, azureRel));
  if (azureText) {
    const audit = auditAzureHyperionCi(azureText, renderOpts);
    if (!audit.ok) {
      findings.push({
        file: azureRel,
        kind: "azure-pipelines",
        issues: audit.issues,
        fix: "npm run hyperion:pipeline-apply -- --refresh-sync --yes",
      });
    }
  }

  return { renderOpts, findings };
}
