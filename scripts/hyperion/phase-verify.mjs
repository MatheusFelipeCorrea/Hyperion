#!/usr/bin/env node
/**
 * Verify that completed phases in an implementation plan recorded a PASS test run.
 * Run: npm run hyperion:phase-verify -- --plan .github/plans/implementations/foo.md
 *      npm run hyperion:phase-verify -- --plan <path> --phase 2
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordEvent } from "./telemetry-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

function usage() {
  console.log(`Usage:
  npm run hyperion:phase-verify -- --plan <path-to-plan.md> [--phase N]
  npm run hyperion:phase-verify -- --latest

Checks that each completed phase (or --phase N) has a Verification block with tests_result: PASS.
`);
}

function findLatestPlan() {
  const dir = join(root, ".github/plans/implementations");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .map((f) => join(dir, f));
  if (!files.length) return null;
  files.sort();
  return files[files.length - 1];
}

function parseVerificationBlocks(text) {
  const blocks = [];
  const re = /##\s+Verification\b([\s\S]*?)(?=\n##\s|\n#\s|$)/gi;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const phase = (body.match(/^\s*-\s*phase:\s*(\S+)/im) || [])[1] || null;
    const testsCommand = (body.match(/^\s*-\s*tests_command:\s*(.+)$/im) || [])[1]?.trim() || null;
    const testsResult = (body.match(/^\s*-\s*tests_result:\s*(\S+)/im) || [])[1] || null;
    const testedAt = (body.match(/^\s*-\s*tested_at:\s*(\S+)/im) || [])[1] || null;
    blocks.push({ phase, testsCommand, testsResult, testedAt, raw: body.trim() });
  }
  return blocks;
}

function phaseLooksComplete(text, phaseNum) {
  const phaseRe = new RegExp(
    `(?:^|\\n)#{2,3}\\s*Phase\\s+${phaseNum}\\b[\\s\\S]*?(?=\\n#{2,3}\\s|$)`,
    "i"
  );
  const section = text.match(phaseRe)?.[0] || "";
  if (!section) return false;
  if (/tests_result:\s*PASS/i.test(section)) return true;
  const checks = [...section.matchAll(/^\s*-\s*\[([ xX])\]/gm)];
  if (!checks.length) return /complete|done|✅/i.test(section);
  return checks.every((c) => c[1].toLowerCase() === "x");
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    process.exit(0);
  }

  let planPath = argValue("--plan");
  if (process.argv.includes("--latest") || !planPath) {
    if (!planPath) planPath = findLatestPlan();
  }
  if (!planPath) {
    console.error("No plan specified and none found under .github/plans/implementations/");
    usage();
    process.exit(1);
  }

  const abs = resolve(process.cwd(), planPath);
  if (!existsSync(abs)) {
    console.error(`Plan not found: ${abs}`);
    process.exit(1);
  }

  const text = readFileSync(abs, "utf8");
  const blocks = parseVerificationBlocks(text);
  const phaseFilter = argValue("--phase");

  let targets = blocks;
  if (phaseFilter) {
    targets = blocks.filter((b) => String(b.phase) === String(phaseFilter));
    if (!targets.length) {
      console.error(`No Verification block for phase ${phaseFilter} in ${planPath}`);
      process.exit(1);
    }
  } else {
    // Infer completed phases that need verification
    const completed = [];
    for (let n = 1; n <= 20; n++) {
      if (phaseLooksComplete(text, n)) completed.push(String(n));
    }
    if (completed.length) {
      targets = completed.map((n) => {
        const existing = blocks.find((b) => String(b.phase) === n);
        return existing || { phase: n, testsResult: null, testsCommand: null, testedAt: null };
      });
    }
  }

  if (!targets.length) {
    if (!blocks.length) {
      console.error(`No ## Verification blocks found in ${planPath}`);
      console.error("After /execute, the plan must include:");
      console.error("## Verification");
      console.error("- phase: N");
      console.error("- tests_command: <commands.test>");
      console.error("- tests_result: PASS|FAIL");
      console.error("- tested_at: ISO-8601");
      process.exit(1);
    }
    targets = blocks;
  }

  let failed = 0;
  for (const b of targets) {
    const label = b.phase ? `phase ${b.phase}` : "unknown phase";
    if (String(b.testsResult || "").toUpperCase() !== "PASS") {
      console.error(`FAIL ${label}: tests_result is "${b.testsResult || "(missing)"}" (need PASS)`);
      failed++;
    } else {
      console.log(`OK ${label}: PASS (${b.testsCommand || "tests_command n/a"}) @ ${b.testedAt || "?"}`);
    }
  }

  if (failed) {
    console.error(`\nphase-verify FAILED (${failed})`);
    process.exit(1);
  }
  recordEvent(root, "agent-gate", "phase-verify", { phases: targets.length });
  console.log(`phase-verify OK (${targets.length} phase(s))`);
}

main();
