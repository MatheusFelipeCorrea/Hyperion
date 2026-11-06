#!/usr/bin/env node
/**
 * Stack-adaptive pre-push check — runs cheap local build/test gates before push.
 *
 * Detects apps via pipeline-gates scanRepoForGates and picks commands by stack:
 *   - node library/api: build (if any) + test
 *   - node web (react/next/vue/…): typecheck (if any) + test
 *   - python / go / rust / java / php / ruby / dart / dotnet: build (when meaningful) + test
 *
 * Only runs for apps whose tree intersects the push diff. Docs/cards/specs alone skip.
 * Bypass: SKIP_PREPUSH=1
 *
 * Invoked by the Hyperion pre-push hook (cards:hook / install-hook.mjs).
 * Stdin: standard git pre-push lines (local_ref local_sha remote_ref remote_sha).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveHyperionPaths } from "./paths.mjs";
import { scanRepoForGates } from "./pipeline-gates.mjs";

const ZERO = "0".repeat(40);
const DOCISH =
  /\.(md|mdx|txt|rst|adoc)$|(^|\/)(\.github\/(cards|plans|docs|memory|audits|agents|skills|commands\.yml)|docs\/|intent\/)/i;

const WEB_FRAMEWORKS = new Set([
  "next",
  "nuxt",
  "remix",
  "astro",
  "sveltekit",
  "gatsby",
  "cra",
  "vite-react",
  "vite-vue",
  "vite-svelte",
  "vite",
  "angular",
  "ember",
]);

export function parsePushRanges(stdinText, cwd) {
  const ranges = [];
  const lines = String(stdinText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [, localSha, , remoteSha] = parts;
    if (!localSha || localSha === ZERO) continue; // delete
    if (parts[0].startsWith("refs/tags/")) continue;
    if (!remoteSha || remoteSha === ZERO) {
      let base = "";
      for (const b of ["origin/dev", "origin/main", "origin/master", "dev", "main", "master"]) {
        try {
          base = execSync(`git merge-base ${localSha} ${b}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
          if (base) break;
        } catch {
          /* try next */
        }
      }
      ranges.push(base ? `${base}..${localSha}` : localSha);
    } else {
      ranges.push(`${remoteSha}..${localSha}`);
    }
  }
  if (!ranges.length) {
    try {
      const upstream = execSync("git rev-parse --abbrev-ref @{upstream}", {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      ranges.push(`${upstream}..HEAD`);
    } catch {
      ranges.push("HEAD");
    }
  }
  return ranges;
}

export function collectChangedFiles(cwd, ranges) {
  const files = new Set();
  for (const range of ranges) {
    try {
      const out = execSync(`git diff --name-only ${range}`, {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      for (const f of out.split(/\r?\n/)) {
        const n = f.trim().replace(/\\/g, "/");
        if (n) files.add(n);
      }
    } catch {
      files.add("__force_check__");
    }
  }
  return [...files];
}

export function isCodeChange(files) {
  if (files.includes("__force_check__")) return true;
  return files.some((f) => !DOCISH.test(f));
}

export function appTouches(appPath, files) {
  const prefix = !appPath || appPath === "." ? "" : appPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return files.some((f) => {
    const n = f.replace(/\\/g, "/");
    if (!prefix) return true;
    return n === prefix || n.startsWith(`${prefix}/`);
  });
}

/** Choose cheap local commands for this app given its stack / web framework. */
export function selectPrePushCommands(app) {
  const gates = app.gates || {};
  const cmd = (g) => (g && g.command ? g.command : null);
  const stack = app.stack || "";
  const webFw = app.web?.framework || "";
  const isWeb = Boolean(webFw) || WEB_FRAMEWORKS.has(webFw);
  const out = [];

  if (stack === "node" || stack === "flutter" || stack === "dart") {
    if (isWeb || stack === "flutter" || stack === "dart") {
      if (cmd(gates.typecheck)) out.push({ name: "typecheck", command: cmd(gates.typecheck) });
      if (cmd(gates.test)) out.push({ name: "test", command: cmd(gates.test) });
    } else {
      if (cmd(gates.build)) out.push({ name: "build", command: cmd(gates.build) });
      if (cmd(gates.test)) out.push({ name: "test", command: cmd(gates.test) });
    }
    return out;
  }

  if (stack === "dotnet" || stack === "java-maven" || stack === "java-gradle" || stack === "rust" || stack === "go") {
    if (cmd(gates.build)) out.push({ name: "build", command: cmd(gates.build) });
    if (cmd(gates.test)) out.push({ name: "test", command: cmd(gates.test) });
    return out;
  }

  if (stack === "python" || stack === "php" || stack === "ruby") {
    if (cmd(gates.test)) out.push({ name: "test", command: cmd(gates.test) });
    return out;
  }

  // Fallback: test then build when present
  if (cmd(gates.test)) out.push({ name: "test", command: cmd(gates.test) });
  else if (cmd(gates.build)) out.push({ name: "build", command: cmd(gates.build) });
  return out;
}

function runCommand(command, cwd) {
  console.log(`[pre-push] → ${command}  (cwd: ${path.relative(process.cwd(), cwd) || "."})`);
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

export function planPrePush(workspaceRoot, files, scan = null) {
  const paths = resolveHyperionPaths(workspaceRoot);
  const scanned = scan || scanRepoForGates(workspaceRoot, { kitRootRel: paths.kitRootRel });
  const plans = [];
  for (const app of scanned.apps || []) {
    if (app.tooling) continue;
    if (!appTouches(app.path, files)) continue;
    const commands = selectPrePushCommands(app);
    if (!commands.length) continue;
    plans.push({
      name: app.name,
      path: app.path || ".",
      stack: app.stack,
      web: app.web?.framework || null,
      commands,
    });
  }
  return plans;
}

export function runPrePushCheck({ root = process.cwd(), stdinText = "", scan = null } = {}) {
  if (process.env.SKIP_PREPUSH === "1") {
    console.log("[pre-push] skipped (SKIP_PREPUSH=1). CI still validates.");
    return 0;
  }
  const workspaceRoot = path.resolve(root);
  const ranges = parsePushRanges(stdinText, workspaceRoot);
  const files = collectChangedFiles(workspaceRoot, ranges);
  if (!isCodeChange(files)) {
    console.log("[pre-push] no code changes in push range — build/test skipped");
    return 0;
  }

  const plans = planPrePush(workspaceRoot, files, scan);
  if (!plans.length) {
    console.log("[pre-push] no runnable build/test gates for touched apps — skipped");
    return 0;
  }

  for (const plan of plans) {
    const cwd = path.join(workspaceRoot, plan.path === "." ? "" : plan.path);
    const label = plan.web ? `${plan.stack}/${plan.web}` : plan.stack;
    console.log(`[pre-push] ${plan.name} (${label})`);
    for (const step of plan.commands) {
      const status = runCommand(step.command, cwd);
      if (status !== 0) {
        console.error("");
        console.error(`[pre-push] ✗ ${step.name} failed for ${plan.name} — push blocked.`);
        console.error("  Fix locally, or bypass (not recommended): SKIP_PREPUSH=1 git push");
        console.error("");
        return 1;
      }
    }
  }
  console.log("[pre-push] ✓ build/test OK");
  return 0;
}

async function main() {
  let stdinText = "";
  if (!process.stdin.isTTY) {
    stdinText = fs.readFileSync(0, "utf8");
  }
  process.exit(runPrePushCheck({ stdinText }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("[pre-push] FATAL:", err.message);
    process.exit(1);
  });
}
