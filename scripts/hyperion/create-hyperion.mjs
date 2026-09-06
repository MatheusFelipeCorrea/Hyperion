#!/usr/bin/env node
/**
 * Scaffold a new product with a nested Hyperion kit — automates the
 * "Preferido" adoption path from GETTING-STARTED.md (clone/ZIP into
 * <product>/Hyperion/, npm install, hyperion:init --adopt) as one command,
 * instead of 4+ manual steps.
 *
 * This is local scaffolding logic, not a published `npx create-hyperion`
 * package — that would need a real npm registry publish, which is a
 * separate, larger decision than this script. Run it from a Hyperion
 * checkout (this one, or any other via --from/--repo).
 *
 * Dry-run by default, same convention as the kit's other file-writing
 * scripts (labels-reset.mjs, migrate-layout.mjs) — pass --yes to apply.
 *
 * Usage:
 *   node scripts/hyperion/create-hyperion.mjs <target-dir>              # preview
 *   node scripts/hyperion/create-hyperion.mjs <target-dir> --yes        # apply
 *   node scripts/hyperion/create-hyperion.mjs <target-dir> --yes --from /path/to/other/kit
 *   node scripts/hyperion/create-hyperion.mjs <target-dir> --yes --repo owner/name --ref main
 *   node scripts/hyperion/create-hyperion.mjs <target-dir> --yes --kit-name Kit --skip-install --skip-adopt
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathExists, fail, log, ok, warn } from "./lib.mjs";
import {
  cleanupTemp,
  fetchRemoteTip,
  materializeKitFromGitHub,
  resolveOrigin,
} from "./upgrade-fetch.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const selfKitRoot = path.resolve(scriptDir, "..", "..");

// Runtime/output directories that exist in a live checkout but carry zero
// scaffolding value — doctor/sync/audit recreate them on first real use.
// Skipped by name at any depth during the local recursive copy; a remote
// --repo fetch never has these in the first place (git never committed them).
const SKIP_DIR_NAMES = new Set([".git", "node_modules"]);
const SKIP_RELATIVE_DIRS = new Set([".github/plans", ".github/audits/results"]);
// This kit's own live project.yml describes THIS repo (name, stack,
// conventions) — its own header says "Adopters: do NOT copy this file".
// project.example.yml (already a plain file, not skipped) is the real
// starting point; /setup or /migrate generates the product's own.
const SKIP_RELATIVE_FILES = new Set([".github/project.yml"]);

function parseArgs(argv) {
  const positional = [];
  let from = "";
  let repo = "";
  let ref = "";
  let kitName = "Hyperion";
  let yes = false;
  let force = false;
  let skipInstall = false;
  let skipAdopt = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = argv[++i] || "";
    else if (a === "--repo") repo = argv[++i] || "";
    else if (a === "--ref") ref = argv[++i] || "";
    else if (a === "--kit-name") kitName = argv[++i] || "Hyperion";
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--force") force = true;
    else if (a === "--skip-install") skipInstall = true;
    else if (a === "--skip-adopt") skipAdopt = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (!a.startsWith("--")) positional.push(a);
  }

  return { targetDir: positional[0] || "", from, repo, ref, kitName, yes, force, skipInstall, skipAdopt, help };
}

function printHelp() {
  log("", "create-hyperion — scaffold a new product with a nested Hyperion kit");
  log("", "");
  log("", "  node scripts/hyperion/create-hyperion.mjs <target-dir> [options]");
  log("", "");
  log("", "  (default)          Preview only (dry-run)");
  log("", "  --yes              Actually copy files, npm install, and adopt");
  log("", "  --from <path>      Use a local kit checkout instead of this one");
  log("", "  --repo owner/name  Fetch the kit from GitHub instead of local");
  log("", "  --ref main         Branch/tag for --repo (default: main)");
  log("", "  --kit-name Kit     Nested folder name (default: Hyperion)");
  log("", "  --skip-install     Don't run npm install inside the nested kit");
  log("", "  --skip-adopt       Don't run install-product-shims.mjs at the end");
  log("", "  --force            Proceed even if the nested kit folder already has files");
}

/** Recursively copy `from` into `to`, skipping runtime/output dirs that
 * carry zero scaffolding value. Returns the number of files copied. */
async function copyKitTree(from, to, { relBase = "" } = {}) {
  const entries = await fs.readdir(from, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const fromPath = path.join(from, entry.name);
    const toPath = path.join(to, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (SKIP_RELATIVE_DIRS.has(rel.replace(/\\/g, "/"))) continue;
      await fs.mkdir(toPath, { recursive: true });
      count += await copyKitTree(fromPath, toPath, { relBase: rel });
    } else if (entry.isFile()) {
      if (SKIP_RELATIVE_FILES.has(rel.replace(/\\/g, "/"))) continue;
      await fs.mkdir(to, { recursive: true });
      await fs.copyFile(fromPath, toPath);
      count += 1;
    }
  }

  return count;
}

async function countKitTreeFiles(from, { relBase = "" } = {}) {
  const entries = await fs.readdir(from, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (SKIP_RELATIVE_DIRS.has(rel.replace(/\\/g, "/"))) continue;
      count += await countKitTreeFiles(path.join(from, entry.name), { relBase: rel });
    } else if (entry.isFile()) {
      if (SKIP_RELATIVE_FILES.has(rel.replace(/\\/g, "/"))) continue;
      count += 1;
    }
  }
  return count;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.targetDir) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const targetRoot = path.resolve(process.cwd(), args.targetDir);
  const nestedKitDir = path.join(targetRoot, args.kitName);

  if ((await pathExists(nestedKitDir)) && !args.force) {
    const existing = await fs.readdir(nestedKitDir).catch(() => []);
    if (existing.length > 0) {
      fail(`${nestedKitDir} already exists and isn't empty. Pass --force to proceed anyway.`);
      process.exit(1);
    }
  }

  let kitRoot = selfKitRoot;
  let tempParent = null;
  let sourceLabel = `local checkout (${selfKitRoot})`;

  try {
    if (args.repo) {
      log("", `Fetching kit from github.com/${args.repo}...`);
      const origin = await resolveOrigin(targetRoot, { repo: args.repo, ref: args.ref || undefined });
      const tip = fetchRemoteTip(origin.repo, origin.ref);
      const mat = materializeKitFromGitHub(origin.repo, origin.ref, tip.sha);
      kitRoot = mat.kitRoot;
      tempParent = mat.tempParent;
      sourceLabel = `github.com/${mat.repo}@${mat.ref} (${mat.sha.slice(0, 12)})`;
    } else if (args.from) {
      kitRoot = path.resolve(args.from);
      if (!(await pathExists(path.join(kitRoot, "scripts", "hyperion")))) {
        fail(`Not a Hyperion kit (missing scripts/hyperion): ${kitRoot}`);
        process.exit(1);
      }
      sourceLabel = `local checkout (${kitRoot})`;
    }

    log("", `Source: ${sourceLabel}`);
    log("", `Target: ${targetRoot}`);
    log("", `Nested kit folder: ${args.kitName}/`);
    log("", args.yes ? "Mode: APPLY (--yes)" : "Mode: DRY-RUN (pass --yes to apply)");
    log("", "");

    const fileCount = await countKitTreeFiles(kitRoot);
    log("", `Would copy ~${fileCount} file(s) into ${path.join(targetRoot, args.kitName)}/`);

    if (!args.yes) {
      warn("Dry-run only. Re-run with --yes to actually scaffold.");
      ok("create-hyperion dry-run complete");
      return;
    }

    await fs.mkdir(nestedKitDir, { recursive: true });
    const copied = await copyKitTree(kitRoot, nestedKitDir);
    ok(`Copied ${copied} file(s) into ${nestedKitDir}`);

    if (!args.skipInstall) {
      log("", "Running npm install inside the nested kit...");
      const install = spawnSync("npm", ["install"], { cwd: nestedKitDir, stdio: "inherit", shell: true });
      if ((install.status ?? 1) !== 0) {
        warn("npm install failed — run it manually inside the nested kit folder.");
      } else {
        ok("npm install complete");
      }
    } else {
      log("", "Skipped npm install (--skip-install)");
    }

    if (!args.skipAdopt) {
      log("", "Running install-product-shims.mjs (writes product-root shims)...");
      const shimsScript = path.join(nestedKitDir, "scripts", "hyperion", "install-product-shims.mjs");
      const shims = spawnSync(process.execPath, [shimsScript], { cwd: targetRoot, stdio: "inherit" });
      if ((shims.status ?? 1) !== 0) {
        warn("install-product-shims.mjs failed — run it manually from the product root.");
      }
    } else {
      log("", "Skipped adopt shims (--skip-adopt)");
    }

    log("", "");
    log("", "Next steps:");
    log("", `  cd ${path.relative(process.cwd(), targetRoot) || "."}`);
    log("", "  Open chat → /setup (new product) or /migrate (existing code)");
    log("", "  Then: /doctor");
    ok("create-hyperion complete");
  } finally {
    cleanupTemp(tempParent);
  }
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
