/**
 * Render .github/workflows/hyperion-product-ci.yml from accepted ci.gates.
 *
 * One job per app (setup → install → lint → format → typecheck → migrations →
 * services/migrate → test/coverage → coverage gate → build → audit → audit-fix check)
 * plus repo-level jobs (docker, compose smoke, e2e, IaC, commitlint, OpenAPI, CodeQL,
 * dependency review, secrets, PR hygiene, web quality, mobile, docs, notify).
 * Mode mapping: block = step fails the job · warn = continue-on-error · off = omitted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHECKOUT, checkout, job, kitScript, q, slug, step } from "./ci-yaml.mjs";
import { languagesFor, resolveLanguages } from "./i18n.mjs";
import { gateCommand, resolveGatePlan, scanRepoForGates } from "./pipeline-gates.mjs";
import {
  a11yJob,
  affectedGate,
  bundleSizeJob,
  changesJob,
  ciText,
  dependencyReviewJob,
  dockerJob,
  dockerPublishJob,
  docsJob,
  installSteps,
  lighthouseJob,
  mobileJobs,
  notifyJob,
  prHygieneJob,
  secretsJob,
  servicesFor,
  setupSteps,
  styleFixJob,
} from "./product-ci-jobs.mjs";

export const GATES_HASH_MARKER = "# hyperion:gates-hash";

function auditFixCheckScript(app, fixCmd, verifyCmd, tr) {
  return [
    "set +e",
    fixCmd,
    'if git -C "$GITHUB_WORKSPACE" diff --quiet; then',
    '  echo "Audit fix: nothing to change."',
    "  exit 0",
    "fi",
    'echo "Audit fix touched: $(git -C "$GITHUB_WORKSPACE" diff --name-only | tr \'\\n\' \' \')"',
    verifyCmd ? verifyCmd : "true",
    "status=$?",
    'git -C "$GITHUB_WORKSPACE" checkout -- .',
    "if [ $status -eq 0 ]; then",
    `  echo "::warning title=Audit fix (${app.name})::${tr.shell(verifyCmd ? "ci.auditFix.ok" : "ci.auditFix.untested", { command: fixCmd })}"`,
    "else",
    `  echo "::warning title=Audit fix (${app.name})::${tr.shell("ci.auditFix.breaks", { command: fixCmd })}"`,
    "fi",
  ].join("\n");
}

function retryScript(cmd, retries, label, tr) {
  if (!retries) return cmd;
  return [
    "attempt=1",
    `until ${cmd}; do`,
    `  if [ "$attempt" -gt ${retries} ]; then exit 1; fi`,
    `  echo "::warning title=Flaky test retry (${label})::${tr.shell("ci.retry.attempt", { attempt: "$attempt" })}"`,
    "  attempt=$((attempt + 1))",
    "done",
  ].join("\n");
}

const andIf = (...conds) => {
  const parts = conds.filter(Boolean);
  return parts.length ? `\${{ ${parts.join(" && ")} }}` : undefined;
};

function appJob(app, plan, ctx) {
  const d = app.decisions;
  const tr = ciText(plan);
  const notes = [];
  const note = (msg) => notes.push(`(${app.name}): ${msg}`);
  const cmd = (g) => gateCommand(app, g, d);
  const coverageCmd = d.coverage.mode !== "off" ? cmd("coverage") : null;
  if (d.coverage.mode !== "off" && !coverageCmd) {
    note(`coverage requested but no coverage command detected — set ci.gates.apps.${app.name}.commands.coverage`);
  }

  const matrix = {};
  if (d.matrix.versions.length) matrix.version = d.matrix.versions;
  if (d.matrix.os.length) matrix.os = d.matrix.os;
  const primary = [
    matrix.version && `matrix.version == ${q(matrix.version[0]).replace(/^"|"$/g, "'")}`,
    matrix.os && `matrix.os == '${matrix.os[0]}'`,
  ]
    .filter(Boolean)
    .join(" && ");
  const version = matrix.version ? "${{ matrix.version }}" : d.version;
  const runsOn = matrix.os ? "${{ matrix.os }}" : d.runner || plan.runner;
  const nonLinux = (matrix.os || [runsOn]).some((os) => /windows|macos/i.test(String(os)));

  let { services, env } = servicesFor(app);
  if (Object.keys(services).length && nonLinux) {
    note("service containers need Linux runners — services skipped for this job");
    services = {};
    env = {};
  }

  const diff = coverageCmd ? d.coverage.diff : null;
  const summaryOut = coverageCmd && d.coverage.comment ? `$RUNNER_TEMP/coverage-${slug(app.name)}.md` : null;
  const pyTools = app.setup?.kind === "python" ? [...(app.setup.tools || [])] : [];
  const steps = [
    diff ? checkout({ "fetch-depth": 0 }) : CHECKOUT,
    ...setupSteps(app, { coverageOn: Boolean(coverageCmd), version }),
    ...installSteps(app, pyTools),
  ];

  if (app.setup?.kind === "go" && app.setup.golangci && d.lint !== "off" && !app.commands?.lint) {
    steps.push(
      step({
        name: "Install golangci-lint",
        run: "curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh | sh -s -- -b \"$(go env GOPATH)/bin\"",
      })
    );
  }

  const simple = [
    ["lint", "Lint"],
    ["format", "Format check (styles)"],
    ["typecheck", "Typecheck"],
    ["migrations", "Migrations check"],
  ];
  for (const [g, label] of simple) {
    if (d[g] === "off") continue;
    const c = cmd(g);
    if (c) steps.push(step({ name: label, run: c, mode: d[g] }));
    else if (app.explicit?.includes(g) || app.custom) {
      note(`${g}: ${d[g]} requested but no command — set ci.gates.apps.${app.name}.commands.${g}`);
    }
  }

  if (d.migrate) {
    const migrateCmd = typeof d.migrate === "string" ? d.migrate : app.commands?.migrate || app.migrate;
    if (migrateCmd) steps.push(step({ name: "Apply migrations (test database)", run: migrateCmd }));
    else note("migrate requested but no migration command detected — set ci.gates.apps.<app>.migrate to a command");
  }

  const testCmd = cmd("test");
  const retryShell = d.retry ? "bash" : undefined;
  if (coverageCmd) {
    const testMode = d.test !== "off" ? d.test : d.coverage.mode;
    steps.push(
      step({
        name: "Test + coverage",
        if: andIf(primary),
        run: retryScript(coverageCmd, d.retry, app.name, tr),
        shell: retryShell,
        mode: testMode,
      })
    );
    if (primary && testCmd && d.test !== "off") {
      steps.push(step({ name: "Test", if: andIf(`!(${primary})`), run: retryScript(testCmd, d.retry, app.name, tr), shell: retryShell, mode: d.test }));
    }
    const args = [
      "--dir .",
      `--metric ${d.coverage.metric}`,
      `--min ${d.coverage.min}`,
      `--mode ${d.coverage.mode}`,
      `--label ${q(app.name)}`,
    ];
    const report = d.coverage.report || app.gates?.coverage?.report;
    if (report) args.push(`--file ${q(report)}`);
    if (d.coverage.ignore.length) args.push(`--ignore ${q(d.coverage.ignore.join(","))}`);
    if (diff) args.push('--diff-base "${{ github.event.pull_request.base.sha }}"', `--diff-min ${diff.min}`, `--diff-mode ${diff.mode}`);
    if (summaryOut) args.push(`--summary-out "${summaryOut}"`);
    const commentLangs = languagesFor(tr.settings, "comments");
    if (commentLangs.join(",") !== "en") args.push(`--lang ${commentLangs.join(",")}`);
    steps.push(
      step({
        name: `Coverage gate (${d.coverage.metric} >= ${d.coverage.min}%${diff ? `, diff >= ${diff.min}%` : ""})`,
        if: andIf(primary),
        run: `node ${kitScript(ctx.kitRootRel, "scripts/hyperion/coverage-gate.mjs")} ${args.join(" ")}`,
        shell: nonLinux ? "bash" : undefined,
      })
    );
    if (summaryOut) {
      steps.push(
        step({
          name: "Coverage comment",
          if: andIf("!cancelled()", "github.event_name == 'pull_request'", "github.event.pull_request.head.repo.full_name == github.repository", primary),
          continueOnError: true,
          uses: "marocchino/sticky-pull-request-comment@v2",
          with: { header: `hyperion-coverage-${slug(app.name)}`, path: `\${{ runner.temp }}/coverage-${slug(app.name)}.md` },
        })
      );
    }
  } else if (d.test !== "off" && testCmd) {
    steps.push(step({ name: "Test", run: retryScript(testCmd, d.retry, app.name, tr), shell: retryShell, mode: d.test }));
  }

  if (plan.artifacts && (coverageCmd || testCmd)) {
    const prefix = app.path === "." ? "" : `${app.path}/`;
    const report = d.coverage.report || app.gates?.coverage?.report;
    const covDir = report && report.includes("/") ? `${report.slice(0, report.lastIndexOf("/"))}/` : "coverage/";
    steps.push(
      step({
        name: "Upload test reports",
        if: "${{ !cancelled() }}",
        uses: "actions/upload-artifact@v4",
        with: {
          name: `reports-${slug(app.name)}${Object.keys(matrix).length ? "-${{ strategy.job-index }}" : ""}`,
          path: [`${prefix}${covDir}`, `${prefix}**/junit*.xml`, `${prefix}test-results/`, "!**/node_modules/**"].join("\n"),
          "if-no-files-found": "ignore",
          "retention-days": 7,
        },
      })
    );
  }

  if (d.build !== "off" && cmd("build")) steps.push(step({ name: "Build", run: cmd("build"), mode: d.build }));

  const auditCmd = d.audit.mode !== "off" ? cmd("audit") : null;
  if (auditCmd) {
    const install = app.gates?.audit?.installTool;
    const run = install && !app.commands?.audit
      ? `${app.setup?.kind === "rust" ? `cargo install ${install} --locked` : `pip install ${install}`}\n${auditCmd}`
      : auditCmd;
    steps.push(
      step({
        name: `Dependency audit${app.gates?.audit?.levelUnsupported ? "" : ` (${d.audit.level}+)`}`,
        if: andIf(primary),
        run,
        mode: d.audit.mode,
      })
    );
  }
  const fixCmd = app.commands?.audit_fix || app.gates?.audit?.fix || null;
  if (d.audit.mode !== "off" && d.audit.fix === "check" && fixCmd) {
    steps.push(
      step({
        name: "Audit fix check (reverted, warn only)",
        if: andIf("!cancelled()", "github.event_name != 'schedule'", primary),
        continueOnError: true,
        shell: nonLinux ? "bash" : undefined,
        run: auditFixCheckScript(app, fixCmd, testCmd, tr),
      })
    );
  }

  return job({
    id: `app-${slug(app.name)}`,
    name: `${app.name} (${app.stack}${matrix.version ? " ${{ matrix.version }}" : ""}${matrix.os ? ", ${{ matrix.os }}" : ""})`,
    ...affectedGate(app, plan),
    runsOn,
    timeout: d.timeout || plan.timeout,
    permissions: summaryOut ? { contents: "read", "pull-requests": "write" } : undefined,
    matrix,
    env,
    services,
    workingDirectory: app.path,
    notes,
    steps,
  });
}

function auditFixPrJob(app, plan, ctx) {
  const d = app.decisions;
  const fixCmd = app.commands?.audit_fix || app.gates?.audit?.fix;
  if (d.audit.mode === "off" || d.audit.fix !== "pr" || !fixCmd) return null;
  const testCmd = gateCommand(app, "test", d);
  const branch = `chore/audit-fix-${slug(app.name)}`;
  const tr = ciText(plan);
  const subject = `chore(deps): ${tr.shell("ci.auditPr.subject", { app: app.name })}`;
  const body = tr.multi("pr", (lang) => tr.tIn(lang, "ci.auditPr.body"));
  const bodyShell = body.trimEnd().replace(/[\\"`$]/g, (c) => `\\${c}`);
  return job({
    id: `audit-fix-${slug(app.name)}`,
    name: `${app.name} — audit fix PR`,
    if: "${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}",
    permissions: { contents: "write", "pull-requests": "write" },
    workingDirectory: app.path,
    steps: [
      CHECKOUT,
      ...setupSteps(app, { version: d.version }),
      ...installSteps(app),
      step({ name: "Apply audit fix", run: fixCmd }),
      ...(testCmd ? [step({ name: "Test with fix applied", run: testCmd })] : []),
      step({
        name: "Open or update PR",
        env: { GH_TOKEN: "${{ secrets.HYPERION_PR_TOKEN || github.token }}", BRANCH: branch, BASE: ctx.prBase },
        run: [
          'cd "$GITHUB_WORKSPACE"',
          'if git diff --quiet; then echo "Nothing to fix."; exit 0; fi',
          'git config user.name "github-actions[bot]"',
          'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
          'git checkout -B "$BRANCH"',
          `git commit -am "${subject}"`,
          'git push --force origin "$BRANCH"',
          `gh pr view "$BRANCH" --json number >/dev/null 2>&1 || gh pr create --base "$BASE" --head "$BRANCH" --title "${subject}" --body "${bodyShell}"`,
        ].join("\n"),
      }),
    ],
  });
}

function composeJob(plan, apps) {
  const c = plan.composeSmoke;
  if (c.mode === "off" || !c.file) return null;
  const dir = c.file.includes("/") ? c.file.slice(0, c.file.lastIndexOf("/")) : ".";
  const base = c.file.slice(c.file.lastIndexOf("/") + 1);
  const owner = apps.find((a) => a.path === dir);
  const services = c.services?.length ? ` ${c.services.join(" ")}` : "";
  const steps = [CHECKOUT];
  if (c.check && owner) steps.push(...setupSteps(owner, { version: owner.decisions.version }), ...installSteps(owner));
  steps.push(
    step({ name: "Prepare .env from example", run: "[ -f .env ] || [ ! -f .env.example ] || cp .env.example .env" }),
    step({ name: "Validate compose file", run: `docker compose -f ${q(base)} config -q` }),
    step({ name: "Start services", run: `docker compose -f ${q(base)} up -d --wait --wait-timeout 180${services}` })
  );
  if (c.check) steps.push(step({ name: "Smoke check", run: c.check }));
  steps.push(
    step({ name: "Service logs on failure", if: "${{ failure() }}", run: `docker compose -f ${q(base)} logs --no-color` }),
    step({ name: "Stop services", if: "${{ always() }}", run: `docker compose -f ${q(base)} down -v` })
  );
  return job({
    id: "compose-smoke",
    name: `Compose smoke (${c.file})`,
    runsOn: plan.runner,
    timeout: 20,
    continueOnError: c.mode === "warn",
    workingDirectory: dir,
    steps,
  });
}

/**
 * The deepest app whose directory contains `dir` (the root app only owns what no nested app does).
 * A package.json between `dir` and that app marks a separate package the plan has no app for.
 */
function owningApp(apps, dir, hasPackageJson = () => false) {
  const d = dir || ".";
  const contains = (a) => a.path === "." || d === a.path || d.startsWith(`${a.path}/`);
  const app = apps.filter(contains).sort((a, b) => b.path.length - a.path.length)[0] || null;
  if (!app) return null;
  for (let p = d; p !== app.path && p !== "."; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".") {
    if (hasPackageJson(p)) return null;
  }
  return app;
}

/** Each e2e config with its owning Node app and a unique job id. */
function e2eTargets(plan, repo, apps, ctx) {
  if (plan.e2e === "off") return [];
  const owned = [];
  for (const e of repo.e2e) {
    const app = owningApp(apps, e.dir, ctx.hasPackageJson);
    if (app && app.setup?.kind === "node") owned.push({ e, app });
  }
  const perApp = new Map();
  for (const { app } of owned) perApp.set(app.name, (perApp.get(app.name) || 0) + 1);
  const usedIds = new Set();
  return owned.map(({ e, app }) => {
    const base = perApp.get(app.name) > 1 ? `e2e-${slug(app.name)}-${slug(e.tool)}` : `e2e-${slug(app.name)}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return { e, app, id };
  });
}

function e2eJobs(plan, targets, ctx) {
  const jobs = [];
  for (const { e, app, id } of targets) {
    const pkgScripts = ctx.readScripts?.(app.path) || {};
    const scriptName = ["test:e2e", "e2e"].find((n) => pkgScripts[n]);
    const pm = app.setup.pm;
    const runScript = scriptName ? (pm === "npm" ? `npm run ${scriptName}` : `${pm} run ${scriptName}`) : null;
    const exec = pm === "pnpm" ? "pnpm exec" : pm === "yarn" ? "yarn" : pm === "bun" ? "bunx" : "npx";
    const configRel = app.path === "." ? e.config : e.config?.slice(app.path.length + 1);
    const nestedConfig = (e.dir || ".") !== app.path && configRel ? ` ${e.tool === "playwright" ? "--config" : "--config-file"} ${q(configRel)}` : "";
    const steps = [CHECKOUT, ...setupSteps(app, { version: app.decisions.version }), ...installSteps(app)];
    if (e.tool === "playwright") {
      steps.push(step({ name: "Install Playwright browsers", run: `${exec} playwright install --with-deps` }));
      steps.push(step({ name: "Playwright e2e", run: runScript || `${exec} playwright test${nestedConfig}` }));
    } else {
      steps.push(step({ name: "Cypress e2e", run: runScript || `${exec} cypress run${nestedConfig}` }));
    }
    jobs.push(
      job({
        id,
        name: `E2E ${e.tool} (${app.name})`,
        ...affectedGate(app, plan),
        runsOn: plan.runner,
        timeout: 30,
        continueOnError: plan.e2e === "warn",
        workingDirectory: app.path,
        steps,
      })
    );
  }
  return jobs;
}

function iacJob(plan, repo) {
  if (plan.iac === "off" || !repo.iac.terraform.length) return null;
  return job({
    id: "iac",
    name: "Terraform fmt + validate",
    runsOn: plan.runner,
    continueOnError: plan.iac === "warn",
    steps: [
      CHECKOUT,
      step({ name: "Setup Terraform", uses: "hashicorp/setup-terraform@v3" }),
      step({ name: "terraform fmt", run: "terraform fmt -check -recursive" }),
      ...repo.iac.terraform.map((dir) =>
        step({ name: `terraform validate (${dir || "."})`, workingDirectory: dir || ".", run: "terraform init -backend=false -input=false\nterraform validate" })
      ),
    ],
  });
}

function commitlintJob(plan) {
  if (plan.commitlint === "off") return null;
  return job({
    id: "commitlint",
    name: "Commit messages",
    if: "${{ github.event_name == 'pull_request' }}",
    runsOn: plan.runner,
    continueOnError: plan.commitlint === "warn",
    steps: [
      checkout({ "fetch-depth": 0 }),
      step({ name: "Setup Node", uses: "actions/setup-node@v5", with: { "node-version": "22" } }),
      step({
        name: "Commitlint",
        run: [
          "ls commitlint.config.* .commitlintrc* >/dev/null 2>&1 || echo \"module.exports = { extends: ['@commitlint/config-conventional'] };\" > commitlint.config.cjs",
          "npm install --no-save --no-package-lock @commitlint/cli@19 @commitlint/config-conventional@19",
          'npx commitlint --from "${{ github.event.pull_request.base.sha }}" --to "${{ github.event.pull_request.head.sha }}" --verbose',
        ].join("\n"),
      }),
    ],
  });
}

function openapiJob(plan, repo) {
  if (plan.openapi === "off" || !repo.openapi.length) return null;
  return job({
    id: "openapi",
    name: "OpenAPI lint",
    runsOn: plan.runner,
    continueOnError: plan.openapi === "warn",
    steps: [
      CHECKOUT,
      step({ name: "Setup Node", uses: "actions/setup-node@v5", with: { "node-version": "22" } }),
      step({ name: "Lint OpenAPI", run: `npx --yes @redocly/cli@latest lint ${repo.openapi.map(q).join(" ")}` }),
    ],
  });
}

function codeqlJob(plan, repo) {
  if (plan.codeql === "off" || !repo.codeqlLanguages.length) return null;
  return [
    "  codeql:",
    "    name: CodeQL (${{ matrix.language }})",
    `    runs-on: ${plan.runner}`,
    ...(plan.codeql === "warn" ? ["    continue-on-error: true"] : []),
    "    permissions:",
    "      actions: read",
    "      contents: read",
    "      security-events: write",
    "    strategy:",
    "      fail-fast: false",
    "      matrix:",
    `        language: [${repo.codeqlLanguages.join(", ")}]`,
    "    steps:",
    [
      CHECKOUT,
      step({
        name: "Init CodeQL",
        uses: "github/codeql-action/init@v3",
        with: { languages: "${{ matrix.language }}", "build-mode": "${{ matrix.language == 'go' && 'autobuild' || 'none' }}" },
      }),
      step({ name: "Analyze", uses: "github/codeql-action/analyze@v3", with: { category: "/language:${{ matrix.language }}" } }),
    ].join("\n\n"),
  ].join("\n");
}

const APP_HASH_FIELDS = ["name", "path", "stack", "decisions", "commands", "gates", "install", "setup", "resolvedServices", "migrate", "web", "bundleSize", "mobile"];

/**
 * Stable hash of every decision that shapes the workflow (for refresh drift).
 * `e2e` (job id → owning app and config) depends on the repo layout, not just the plan,
 * so the renderer passes it; compare against readGatesHash(rendered content) when it matters.
 */
export function gatesHash(plan, { e2e = [] } = {}) {
  const { apps, i18n, i18nRoot, ...rest } = plan;
  const shape = { ...rest, apps: apps.map((a) => Object.fromEntries(APP_HASH_FIELDS.map((k) => [k, a[k] ?? null]))) };
  if (i18n && (i18n.primary !== "en" || i18n.languages.length > 1)) {
    shape.languages = { languages: i18n.languages, multilingual: i18n.multilingual };
  }
  if (e2e.length) shape.e2eJobs = e2e.map((t) => `${t.id}=${t.app.path}:${t.e.config || t.e.dir || "."}`);
  return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

export function readGatesHash(workflowText) {
  const m = String(workflowText || "").match(/^# hyperion:gates-hash ([0-9a-f]+)\s*$/m);
  return m ? m[1] : null;
}

const jobId = (text) => text.match(/^ {2}([a-z0-9-]+):$/m)?.[1] || null;

/**
 * @param {{ scan: object, plan: object, kitRootRel?: string, defaultBranch?: string, readScripts?: (dir: string) => Record<string,string>, hasPackageJson?: (dir: string) => boolean }} input
 */
export function renderProductCiFromGates({ scan, plan, kitRootRel = "", defaultBranch = "main", readScripts = null, hasPackageJson = undefined }) {
  const branches = plan.branches || [defaultBranch];
  const ctx = { kitRootRel, prBase: branches[0], readScripts, hasPackageJson };
  const needsSchedule = plan.apps.some((a) => a.decisions.audit.mode !== "off" && a.decisions.audit.fix === "pr");
  const publishTags = Boolean(plan.docker.publish?.tags) && scan.repo.dockerfiles.length > 0;

  const on = ["on:", "  push:", `    branches: [${branches.join(", ")}]`];
  if (publishTags) on.push('    tags: ["v*"]');
  if (plan.pathsIgnore.length) on.push("    paths-ignore:", ...plan.pathsIgnore.map((p) => `      - ${q(p)}`));
  if (plan.pullRequest) {
    on.push("  pull_request:");
    if (plan.pathsIgnore.length) on.push("    paths-ignore:", ...plan.pathsIgnore.map((p) => `      - ${q(p)}`));
  }
  if (plan.mergeGroup) on.push("  merge_group:");
  on.push("  workflow_dispatch:");
  if (needsSchedule) on.push("  schedule:", '    - cron: "0 6 * * 1"');

  const appJobs = plan.apps.map((a) => appJob(a, plan, ctx));
  const e2e = e2eTargets(plan, scan.repo, plan.apps, ctx);
  const gateJobs = [
    changesJob(plan),
    ...appJobs,
    ...plan.apps.map((a) => styleFixJob(a, plan)),
    ...plan.apps.map((a) => auditFixPrJob(a, plan, ctx)),
    dockerJob(plan, scan.repo),
    composeJob(plan, plan.apps),
    ...e2eJobs(plan, e2e, ctx),
    iacJob(plan, scan.repo),
    commitlintJob(plan),
    openapiJob(plan, scan.repo),
    codeqlJob(plan, scan.repo),
    dependencyReviewJob(plan),
    secretsJob(plan),
    prHygieneJob(plan),
    lighthouseJob(plan, plan.apps),
    a11yJob(plan, plan.apps),
    bundleSizeJob(plan, plan.apps),
    ...mobileJobs(plan, plan.apps),
    docsJob(plan, scan.repo, { kitRootRel }),
  ].filter(Boolean);

  const publishNeeds = [...appJobs, gateJobs.find((j) => jobId(j) === "docker")].filter(Boolean).map(jobId);
  const publish = dockerPublishJob(plan, scan.repo, { needs: publishNeeds, branches: [branches[0]] });
  if (publish) gateJobs.push(publish);
  const notify = notifyJob(plan, gateJobs.map(jobId).filter((id) => id && id !== "changes"));
  const jobs = notify ? [...gateJobs, notify] : gateJobs;

  if (!jobs.length) {
    jobs.push(job({ id: "no-gates", steps: [step({ name: "No gates enabled", run: 'echo "ci.gates has no enabled gate — edit .github/project.yml"' })] }));
  }

  return [
    "name: Hyperion — Product CI",
    "",
    "# Generated by Hyperion from ci.gates in .github/project.yml — do not edit by hand.",
    "# Re-render after changing ci.gates: npm run hyperion:pipeline-apply -- --refresh-gates --yes",
    "# To keep manual edits, add a comment line starting with `# hyperion:no-auto-refresh` (refresh will skip this file).",
    `${GATES_HASH_MARKER} ${gatesHash(plan, { e2e })}`,
    "",
    ...on,
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: hyperion-product-ci-${{ github.ref }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "",
    "jobs:",
    jobs.join("\n\n"),
    "",
  ].join("\n");
}

/** Convenience: scan + resolve + render in one call (used by pipeline-apply). */
export function renderProductCiForRepo(root, { gates, kitRootRel = "", defaultBranch = "main" } = {}) {
  const scan = scanRepoForGates(root, { kitRootRel });
  const plan = resolveGatePlan(scan, gates);
  const { primary, languages, multilingual } = resolveLanguages(root);
  plan.i18n = { primary, languages, multilingual };
  plan.i18nRoot = root;
  const readScripts = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8")).scripts || {};
    } catch {
      return {};
    }
  };
  const hasPackageJson = (dir) => fs.existsSync(path.join(root, dir, "package.json"));
  return { scan, plan, content: renderProductCiFromGates({ scan, plan, kitRootRel, defaultBranch, readScripts, hasPackageJson }) };
}
