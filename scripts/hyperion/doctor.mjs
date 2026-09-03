import process from "node:process";
import {
  collectHyperionHealth,
  fail,
  ok,
  runNodeScriptAsync,
  warn,
  log,
  workspaceRoot,
} from "./lib.mjs";
import { detectPipeline, buildPipelinePlan, auditHyperionPipelineFiles } from "./pipeline-lib.mjs";

const argYes = process.argv.includes("--yes");
const argSkipCards = process.argv.includes("--skip-cards");

async function main() {
  log("", "Hyperion doctor — kit health check");
  log("", "");

  const health = await collectHyperionHealth();
  const detection = await detectPipeline();
  const plan = buildPipelinePlan(detection);

  log("", `Node.js: ${process.version} ${health.nodeMajor >= 20 ? "(OK)" : "(upgrade required)"}`);
  log("", `Repository: ${health.repo || "not detected"}`);
  log("", `GitHub token: ${health.token ? "available" : "missing"}`);
  log("", `project.yml: ${health.hasProjectYml ? "present" : "missing"}`);
  log("", `memory/PROJECT.md: ${health.memoryFilled ? "filled" : "template/empty"}`);
  log("", `CI policy: ${detection.config.policy} · stack: ${detection.stack} · product CI: ${detection.hasProductCi ? "yes" : "no"}`);
  log("", "");
  for (const msg of health.issues) fail(msg);
  for (const msg of health.warnings) warn(msg);
  for (const w of plan.warnings) warn(w);

  const pipelineAudit = await auditHyperionPipelineFiles(workspaceRoot, {
    expectSyncWorkflow:
      detection.config.hyperion.cards_sync &&
      (detection.config.provider === "github-actions" || detection.config.provider === "none"),
  });
  for (const finding of pipelineAudit.findings) {
    warn(`${finding.file} outdated (${finding.issues.join(", ")}) — ${finding.fix}`);
  }

  if (!detection.classified.hyperion.includes("hyperion-sync-cards.yml") && detection.config.hyperion.cards_sync) {
    if (!pipelineAudit.findings.some((f) => f.file.endsWith("hyperion-sync-cards.yml"))) {
      warn("hyperion-sync-cards.yml missing — run: npm run hyperion:pipeline-apply -- --yes");
    }
  }

  if (health.issues.length === 0 && health.warnings.length === 0) {
    ok("Kit structure looks good.");
  }

  let cardsWarningCount = 0;
  if (!argSkipCards && health.hasProjectsMap) {
    log("", "");
    log("", "Running cards-sync doctor...");
    const cards = await runNodeScriptAsync("doctor.mjs", argYes ? ["--yes"] : []);
    const cardsOutputOk =
      cards.stdout.includes("Doctor finished.") &&
      !cards.stdout.includes("Missing required Project fields");
    cardsWarningCount = (cards.stdout.match(/\[doctor\] ⚠️/g) || []).length;
    if (cards.code !== 0) {
      if (process.platform === "win32" && cardsOutputOk) {
        warn("cards-sync doctor: Windows Node cleanup quirk — output OK, continuing.");
      } else {
        fail("cards-sync doctor reported issues.");
        process.exit(cards.code);
      }
    }
  }

  const totalWarnings = health.warnings.length + cardsWarningCount;

  log("", "");
  if (health.issues.length > 0) {
    fail(`Doctor finished with ${health.issues.length} blocking issue(s).`);
    log("", "Fix blockers, then re-run: npm run hyperion:doctor");
    process.exit(1);
  }

  if (totalWarnings > 0) {
    warn(`Doctor finished with ${totalWarnings} warning(s) — kit usable, improvements recommended.`);
    log("", "Agent shortcut: ask \"Rode o doctor do Hyperion\" or /doctor");
    process.exit(0);
  }

  ok("Doctor complete — no issues.");
}

main().catch((error) => {
  fail(`FATAL: ${error.message}`);
  process.exit(1);
});
