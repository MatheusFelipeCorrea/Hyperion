import process from "node:process";
import { collectHyperionHealth, fail, log, ok, runNodeScript, warn } from "./lib.mjs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

async function main() {
  log("", "Hyperion sync — validate then push cards");
  log("", "");

  const health = await collectHyperionHealth();
  if (health.issues.length > 0) {
    for (const msg of health.issues) fail(msg);
    process.exit(1);
  }

  const validateCode = runNodeScript("validate.mjs");
  if (validateCode !== 0) process.exit(validateCode);

  let finalSyncArgs = [...argv];
  if (!dryRun && !health.token) {
    warn("No GitHub token — running dry-run only. Use: gh auth login");
    finalSyncArgs = ["--dry-run", ...argv];
  }

  const syncCode = runNodeScript("sync.mjs", finalSyncArgs);
  if (syncCode !== 0) process.exit(syncCode);

  ok(finalSyncArgs.includes("--dry-run") ? "Dry-run complete." : "Sync complete.");
}

main().catch((error) => {
  fail(`FATAL: ${error.message}`);
  process.exit(1);
});
