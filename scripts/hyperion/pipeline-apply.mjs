#!/usr/bin/env node
/**
 * Apply Hyperion workflows per ci policy (never overwrites product CI).
 * Run: npm run hyperion:pipeline-apply
 *
 * Flags:
 *   --yes              Write planned files (and refresh targets when combined with --refresh-sync)
 *   --refresh-sync     Refresh hyperion-sync-cards.yml and CI snippets when outdated (safe overwrite)
 *   --migrate-legacy   Remove legacy ci.yml / sync-cards.yml after hyperion-* exist
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  detectPipeline,
  buildPipelinePlan,
  LEGACY_WORKFLOWS,
  TEMPLATES_DIR,
  CI_TEMPLATES_DIR,
  HYPERION_WORKFLOWS,
  WORKFLOWS_DIR,
  renderSyncCardsWorkflow,
  renderPrBoardGuardWorkflow,
  renderPrRecheckWorkflow,
  renderGitLabHyperionCi,
  renderAzureHyperionCi,
  auditSyncCardsWorkflow,
  auditPrBoardGuardWorkflow,
  auditPrRecheckWorkflow,
  auditGitLabHyperionCi,
  auditAzureHyperionCi,
  resolvePipelineRenderOptions,
} from "./pipeline-lib.mjs";
import { workspaceRoot, log, ok, warn, fail, readTextIfExists } from "./lib.mjs";

const argYes = process.argv.includes("--yes");
const argMigrateLegacy = process.argv.includes("--migrate-legacy");
const argRefreshSync = process.argv.includes("--refresh-sync");

const REFRESH_TARGETS = [
  {
    file: `${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.syncCards}`,
    template: HYPERION_WORKFLOWS.syncCards,
    audit: auditSyncCardsWorkflow,
    render: (opts) => renderSyncCardsWorkflow(opts),
  },
  {
    file: `${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.cardsPrGuard}`,
    template: HYPERION_WORKFLOWS.cardsPrGuard,
    audit: auditPrBoardGuardWorkflow,
    render: (opts) => renderPrBoardGuardWorkflow(opts),
  },
  {
    file: `${WORKFLOWS_DIR}/${HYPERION_WORKFLOWS.cardsPrRecheck}`,
    template: HYPERION_WORKFLOWS.cardsPrRecheck,
    audit: auditPrRecheckWorkflow,
    render: () => renderPrRecheckWorkflow(),
  },
  {
    file: ".gitlab/hyperion-ci.yml",
    template: "gitlab-hyperion.yml",
    audit: auditGitLabHyperionCi,
    render: (opts) => renderGitLabHyperionCi(opts),
  },
  {
    file: "hyperion-azure-pipelines.yml",
    template: "azure-pipelines-hyperion.yml",
    audit: auditAzureHyperionCi,
    render: (opts) => renderAzureHyperionCi(opts),
  },
];

function renderForTemplate(template, renderOpts) {
  if (template === HYPERION_WORKFLOWS.syncCards) return renderSyncCardsWorkflow(renderOpts);
  if (template === HYPERION_WORKFLOWS.cardsPrGuard) return renderPrBoardGuardWorkflow(renderOpts);
  if (template === HYPERION_WORKFLOWS.cardsPrRecheck) return renderPrRecheckWorkflow(renderOpts);
  if (template === "gitlab-hyperion.yml") return renderGitLabHyperionCi(renderOpts);
  if (template === "azure-pipelines-hyperion.yml") return renderAzureHyperionCi(renderOpts);
  return null;
}

async function readTemplate(action, renderOpts) {
  const rendered = renderForTemplate(action.template, renderOpts);
  if (rendered) return rendered;

  const dir = action.templateDir === "ci" ? CI_TEMPLATES_DIR : TEMPLATES_DIR;
  const p = path.join(workspaceRoot, dir, action.template);
  return fs.readFile(p, "utf8");
}

async function removeLegacy() {
  for (const name of LEGACY_WORKFLOWS) {
    const rel = `.github/workflows/${name}`;
    const abs = path.join(workspaceRoot, rel);
    try {
      await fs.unlink(abs);
      ok(`Removed legacy ${rel}`);
    } catch {
      /* absent */
    }
  }
}

async function refreshOutdatedWorkflows(renderOpts, { yes }) {
  let refreshed = 0;

  for (const target of REFRESH_TARGETS) {
    const abs = path.join(workspaceRoot, target.file);
    const existing = await readTextIfExists(abs);
    if (!existing) continue;

    const audit = target.audit(existing, renderOpts);
    if (audit.ok) {
      log("", `  = ${target.file} (up to date)`);
      continue;
    }

    if (!yes) {
      warn(`${target.file} outdated (${audit.issues.join(", ")})`);
      continue;
    }

    const content = target.render(renderOpts);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    ok(`Refreshed ${target.file} (${audit.issues.join(", ")})`);
    refreshed++;
  }

  return refreshed;
}

async function main() {
  const renderOpts = resolvePipelineRenderOptions(workspaceRoot);
  const detection = await detectPipeline();
  const plan = buildPipelinePlan(detection);

  if (detection.config.policy === "skip") {
    warn("ci.policy=skip — no workflows written.");
    process.exit(0);
  }

  for (const w of plan.warnings) warn(w);

  if (argRefreshSync) {
    log("", `Refresh sync (default branch: ${renderOpts.defaultBranch}, kit: ${renderOpts.kitRootRel || "root"})`);
    if (!argYes) {
      warn("Dry-run refresh. Re-run with --refresh-sync --yes to overwrite outdated Hyperion pipeline files.");
    }
    const refreshed = await refreshOutdatedWorkflows(renderOpts, { yes: argYes });
    if (argYes) {
      ok(`Refresh complete (${refreshed} file(s) updated).`);
    }
    if (!argYes && plan.actions.length === 0 && !argMigrateLegacy) {
      process.exit(0);
    }
  }

  if (plan.actions.length === 0 && !argMigrateLegacy && !argRefreshSync) {
    warn("Nothing to apply. Run pipeline-detect to review policy.");
    process.exit(0);
  }

  if (!argYes && plan.actions.length > 0) {
    log("", "Dry-run only. Re-run with --yes to write files:");
    for (const a of plan.actions) log("", `  ${a.file}`);
    log("", "  npm run hyperion:pipeline-apply -- --yes");
    log("", "  npm run hyperion:pipeline-apply -- --refresh-sync --yes  # update outdated sync workflow");
    process.exit(0);
  }

  let written = 0;
  for (const action of plan.actions) {
    const abs = path.join(workspaceRoot, action.file);
    let exists = false;
    try {
      await fs.access(abs);
      exists = true;
    } catch {
      /* new */
    }

    if (exists && !argRefreshSync) {
      warn(`Exists — skipped: ${action.file}`);
      continue;
    }

    if (exists && argRefreshSync) {
      const target = REFRESH_TARGETS.find((t) => t.file === action.file);
      if (target) {
        const existing = await readTextIfExists(abs);
        const audit = target.audit(existing, renderOpts);
        if (audit.ok) {
          warn(`Exists and up to date — skipped: ${action.file}`);
          continue;
        }
      }
    }

    const content = await readTemplate(action, renderOpts);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    ok(`Wrote ${action.file}`);
    written++;
  }

  if (argMigrateLegacy && detection.classified.legacy.length > 0) {
    if (!argYes) {
      warn("Legacy workflows found. Run with --yes --migrate-legacy to remove ci.yml, sync-cards.yml, security.yml after hyperion-* exist.");
    } else {
      await removeLegacy();
    }
  }

  log("", "");
  ok(`Pipeline apply complete (${written} file(s) written).`);
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
