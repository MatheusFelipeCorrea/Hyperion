#!/usr/bin/env node
/**
 * Upgrade Hyperion kit files inside a client repo.
 *
 * Remote (default — like npm audit / npm update):
 *   npm run hyperion:upgrade              # check GitHub origin + dry-run plan
 *   npm run hyperion:upgrade -- --check   # only say if updates exist (exit 1 if behind)
 *   npm run hyperion:upgrade -- --yes     # fetch + apply
 *
 * Local (offline / custom tree):
 *   npm run hyperion:upgrade -- --from /path/to/kit
 *   npm run hyperion:upgrade -- --from /path/to/kit --yes
 *
 * Origin: .github/hyperion-origin.json | HYPERION_ORIGIN_REPO | --repo owner/name
 */
import process from "node:process";
import path from "node:path";
import { pathExists, fail, log, ok, warn } from "./lib.mjs";
import {
  applyUpgradePlan,
  buildUpgradePlan,
  summarizePlan,
} from "./upgrade-lib.mjs";
import {
  cleanupTemp,
  fetchRemoteTip,
  materializeKitFromGitHub,
  readLocalKitMeta,
  resolveOrigin,
  sameCommit,
} from "./upgrade-fetch.mjs";

function parseArgs(argv) {
  let from = process.env.HYPERION_KIT_ROOT || "";
  let repo = "";
  let ref = "";
  let yes = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = argv[++i] || "";
    else if (a.startsWith("--from=")) from = a.slice("--from=".length);
    else if (a === "--repo") repo = argv[++i] || "";
    else if (a.startsWith("--repo=")) repo = a.slice("--repo=".length);
    else if (a === "--ref") ref = argv[++i] || "";
    else if (a.startsWith("--ref=")) ref = a.slice("--ref=".length);
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--dry-run") {
      /* default without --yes */
    } else if (a === "--check") check = true;
    else if (a === "--help" || a === "-h") return { help: true };
  }
  return { from, repo, ref, yes, check, help: false };
}

function printHelp() {
  log("", "hyperion:upgrade — update kit files from GitHub origin (or --from)");
  log("", "");
  log("", "  (default)          Check origin on GitHub, show plan (dry-run)");
  log("", "  --yes              Fetch + apply updates");
  log("", "  --check            Exit 0 if up to date, 1 if updates available");
  log("", "  --repo owner/name  Override origin repo");
  log("", "  --ref main         Override branch/tag");
  log("", "  --from <path>      Use local kit instead of GitHub");
  log("", "");
  log("", "Origin file: .github/hyperion-origin.json");
  log("", "Pin file:    .github/hyperion-kit.json (written after --yes)");
  log("", "");
  log("", "Preserved: project.yml, memory/, cards/, plans/, .env");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const targetRoot = process.cwd();
  let kitRoot = null;
  let tempParent = null;
  let sourceLabel = "";
  let remoteMeta = null;

  try {
    if (args.from) {
      kitRoot = path.resolve(args.from);
      if (!(await pathExists(kitRoot))) {
        fail(`Kit path not found: ${kitRoot}`);
        process.exit(1);
      }
      if (!(await pathExists(path.join(kitRoot, "scripts", "hyperion")))) {
        fail(`Not a Hyperion kit (missing scripts/hyperion): ${kitRoot}`);
        process.exit(1);
      }
      if (path.resolve(kitRoot) === path.resolve(targetRoot)) {
        fail("Refuse to upgrade: --from is the same as cwd.");
        process.exit(1);
      }
      sourceLabel = kitRoot;
      log("", `Source: local ${kitRoot}`);
    } else {
      const origin = await resolveOrigin(targetRoot, {
        repo: args.repo || undefined,
        ref: args.ref || undefined,
      });
      log("", `Origin: github.com/${origin.repo}@${origin.ref}`);

      const tip = fetchRemoteTip(origin.repo, origin.ref);
      log("", `Remote tip: ${tip.sha.slice(0, 12)}… (${tip.method})`);

      const local = await readLocalKitMeta(targetRoot);
      if (local?.commit && sameCommit(local.commit, tip.sha)) {
        ok(`Already up to date (pinned ${String(local.commit).slice(0, 12)})`);
        if (args.check) process.exit(0);
        process.exit(0);
      }

      if (local?.commit) {
        warn(
          `Local pin ${String(local.commit).slice(0, 12)} ≠ remote ${tip.sha.slice(0, 12)}`
        );
      } else {
        warn("No .github/hyperion-kit.json pin yet — first remote upgrade");
      }

      if (args.check) {
        fail("Updates available");
        process.exit(1);
      }

      log("", "Fetching kit (shallow clone)…");
      const mat = materializeKitFromGitHub(origin.repo, origin.ref, tip.sha);
      kitRoot = mat.kitRoot;
      tempParent = mat.tempParent;
      remoteMeta = { repo: mat.repo, ref: mat.ref, commit: mat.sha };
      sourceLabel = `github.com/${mat.repo}@${mat.ref} (${mat.sha.slice(0, 12)})`;
      log("", `Source: ${sourceLabel}`);
    }

    log("", `Target: ${targetRoot}`);
    log("", args.yes ? "Mode: APPLY (--yes)" : "Mode: DRY-RUN (pass --yes to apply)");
    log("", "");

    const items = await buildUpgradePlan(kitRoot, targetRoot);
    const counts = summarizePlan(items);
    const show = items.filter((i) => i.action === "add" || i.action === "update");
    const capped = show.slice(0, 40);
    for (const i of capped) {
      const tag = i.action === "add" ? "ADD   " : "UPDATE";
      log("", `  ${tag}  ${i.rel}${i.reason ? `  (${i.reason})` : ""}`);
    }
    if (show.length > capped.length) {
      log("", `  … +${show.length - capped.length} more`);
    }

    log("", "");
    log(
      "",
      `Plan: +${counts.add} add · ~${counts.update} update · =${counts.unchanged} same · ⊘${counts.preserve} preserve`
    );

    if (!args.yes) {
      warn("Dry-run only. Re-run with --yes to fetch/apply (remote) or apply (--from).");
      ok("hyperion:upgrade dry-run complete");
      // Return (not process.exit) so the `finally` below still runs and
      // cleans up the temp clone from materializeKitFromGitHub — exiting
      // here used to skip it and leak a hyperion-upgrade-* dir per run.
      return;
    }

    const applied = await applyUpgradePlan(kitRoot, targetRoot, items, {
      yes: true,
      remoteMeta,
      sourceLabel,
    });
    ok(`Applied ${applied.length} paths`);
    log("", "Next: npm run hyperion:doctor");
    ok("hyperion:upgrade complete");
  } finally {
    cleanupTemp(tempParent);
  }
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
