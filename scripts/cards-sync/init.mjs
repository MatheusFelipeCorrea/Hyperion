import "./load-env.mjs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  detectRepoFromGit,
  detectTokenFromGhCli,
  readJsonIfExists,
  resolveRepoConfig,
  discoverGitHubProjectNumber,
} from "./lib.mjs";

const workspaceRoot = process.cwd();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(workspaceRoot, ".github", "cards", "config", "projects-map.json");

const argYes = process.argv.includes("--yes");
const argSkipSync = process.argv.includes("--skip-sync");
const argInstallHook = process.argv.includes("--install-hook");

function log(msg) {
  console.log(`[cards-init] ${msg}`);
}

function runScript(scriptName, args = []) {
  const scriptPath = path.join(scriptDir, scriptName);
  log(`→ node ${path.relative(workspaceRoot, scriptPath)} ${args.join(" ")}`.trim());
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

async function main() {
  log("Hyperion cards init (GitHub automation bootstrap)");
  log("");

  const repositorySlug = process.env.GITHUB_REPOSITORY || detectRepoFromGit() || "unknown/unknown";
  const [repoOwner, repoName] = repositorySlug.split("/");
  const token =
    process.env.PROJECT_SYNC_TOKEN || process.env.GITHUB_TOKEN || detectTokenFromGhCli();

  log(`Repository: ${repositorySlug} (${detectRepoFromGit() ? "git auto-detect" : "env/fallback"})`);
  log(`Token: ${token ? "available" : "missing — see .github/docs/integration/github-cli-setup.md (gh auth login)"}`);

  const config = await readJsonIfExists(configPath);
  if (!config) {
    log("ERROR: missing .github/cards/config/projects-map.json");
    log("Run cards-sync-setup skill or copy from Hyperion.");
    process.exit(1);
  }

  const repoConfig = resolveRepoConfig(config, repositorySlug);
  const backend = String(
    process.env.CARDS_SYNC_BACKEND || repoConfig.backend || "github"
  ).toLowerCase();

  if (backend !== "github") {
    log(`Backend is '${backend}' — cards:init is optimized for GitHub. Use integration-bridge for other backends.`);
  }

  if (backend === "github" && token && repoOwner !== "unknown") {
    log("");
    log("Step 1/5 — Auto-discover GitHub Project number...");
    try {
      const discovery = await discoverGitHubProjectNumber({
        token,
        owner: repoOwner,
        repoName,
        repoConfig,
        configPath,
        repositorySlug,
      });

      if (discovery.discovered) {
        log(`  ✅ Found project #${discovery.projectNumber} — "${discovery.projectTitle}"`);
        log(`  Saved to projects-map.json`);
      } else if (discovery.reason === "already_configured") {
        log(`  = projectNumber already set (#${discovery.projectNumber})`);
      } else if (discovery.reason === "ambiguous") {
        log("  ⚠️  Multiple projects found — set projectNumber manually in projects-map.json");
        for (const c of discovery.candidates || []) {
          log(`     - #${c.number}: ${c.title}`);
        }
      } else if (discovery.reason === "not_found") {
        log("  = No project yet — sync will auto-create on first real sync (if enabled)");
      } else {
        log(`  = Skipped discovery (${discovery.reason})`);
      }
    } catch (error) {
      log(`  ⚠️  Project discovery failed: ${error.message}`);
    }
  } else {
    log("Step 1/5 — Skipped project discovery (no token or repo)");
  }

  log("");
  log("Step 2/6 — Reset repository labels (Hyperion catalog)...");
  const labelsCode = runScript("labels-reset.mjs", argYes ? ["--yes"] : ["--dry-run"]);
  if (labelsCode !== 0) process.exit(labelsCode);

  log("");
  log("Step 3/6 — Doctor (local + remote checks)...");
  const doctorCode = runScript("doctor.mjs", ["--yes"]);
  if (doctorCode !== 0) {
    log("Doctor reported issues — fix them and re-run cards:init");
    process.exit(doctorCode);
  }

  log("");
  log("Step 3/6 — Validate cards...");
  const validateCode = runScript("validate.mjs");
  if (validateCode !== 0) process.exit(validateCode);

  log("");
  log("Step 4/6 — Dry-run sync...");
  const dryRunCode = runScript("sync.mjs", ["--dry-run"]);
  if (dryRunCode !== 0) process.exit(dryRunCode);

  if (argSkipSync) {
    log("");
    log("Step 5/6 — Skipped real sync (--skip-sync)");
  } else if (!token) {
    log("");
    log("Step 5/6 — Skipped real sync (no token). Run: npm run cards:sync");
  } else if (argYes) {
    log("");
    log("Step 5/6 — Real sync (--yes)...");
    const syncCode = runScript("sync.mjs");
    if (syncCode !== 0) process.exit(syncCode);
  } else {
    log("");
    log("Step 5/6 — Real sync skipped.");
    log("Run `npm run cards:sync` or `npm run cards:init -- --yes` to push to GitHub.");
  }

  if (argInstallHook) {
    log("");
    log("Installing pre-commit hook...");
    const hookCode = runScript("install-hook.mjs", ["--yes"]);
    if (hookCode !== 0) process.exit(hookCode);
  }

  log("");
  log("✅ Init complete.");
  log("Next: npm run cards:watch  (auto-sync on save)");
}

main().catch((error) => {
  console.error("[cards-init] FATAL:", error.message);
  process.exit(1);
});
