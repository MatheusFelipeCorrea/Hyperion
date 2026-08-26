#!/usr/bin/env node
/**
 * One-shot Hyperion entry for a host repo (after copying the kit).
 * Run: npm run hyperion:init
 *      npm run hyperion:init -- --yes
 *
 * Checklist: doctor → repo-detect hint → cursor rules → optional setup.
 * Does not publish to npm; prepares the local kit for /setup or /migrate.
 */
import process from "node:process";
import { collectHyperionHealth, fail, log, ok, runHyperionScript, warn } from "./lib.mjs";

const argYes = process.argv.includes("--yes");
const argSetup = process.argv.includes("--setup");
const argAdopt = process.argv.includes("--adopt");

async function main() {
  if (argAdopt) {
    log("", "Hyperion init — adopt nested kit (product shims)");
    const code = runHyperionScript("install-product-shims.mjs", argYes ? ["--force"] : []);
    process.exit(code);
  }

  log("", "Hyperion init — local kit checklist");
  log("", "");

  const health = await collectHyperionHealth();
  for (const msg of health.issues) fail(msg);
  if (health.issues.length > 0) {
    log("", "Fix blockers above, then re-run: npm run hyperion:init");
    process.exit(1);
  }

  ok("Kit layout looks healthy");

  log("", "Detecting repo commands...");
  runHyperionScript("repo-detect.mjs");

  log("", "Installing Cursor rules (if applicable)...");
  const cursorCode = runHyperionScript("install-cursor-rules.mjs");
  if (cursorCode !== 0) warn("Cursor rules skipped — copy .cursor/rules/ manually if needed");

  log("", "Doctor...");
  const doctorCode = runHyperionScript("doctor.mjs");
  if (doctorCode !== 0) warn("Doctor reported issues — see output above");

  log("", "");
  log("", "Next steps:");
  if (!health.hasProjectYml) {
    log("", "  • Existing code? Ask in chat: /migrate");
    log("", "  • New repo? Ask in chat: /setup");
  } else {
    log("", "  • Ask: /doctor  then  /refine");
  }
  log("", "  • Docs: GETTING-STARTED.md");
  log("", "");

  if (argSetup) {
    log("", "Running hyperion:setup...");
    const args = argYes ? ["--yes"] : [];
    const code = runHyperionScript("setup.mjs", args);
    process.exit(code);
  }

  ok("hyperion:init complete");
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
