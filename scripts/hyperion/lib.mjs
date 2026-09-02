import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectRepoFromGit, detectTokenFromGhCli } from "../cards-sync/lib.mjs";

export const workspaceRoot = process.cwd();
export const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const cardsSyncDir = path.join(scriptDir, "..", "cards-sync");

export function log(prefix, msg) {
  console.log(`[Hyperion] ${prefix} ${msg}`);
}

export function ok(msg) {
  log("✅", msg);
}

export function warn(msg) {
  log("⚠️ ", msg);
}

export function fail(msg) {
  log("❌", msg);
}

export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function isTableSeparatorLine(line) {
  return /^[\s:|-]+$/.test(line) && line.includes("-");
}

function sectionHasRealContent(section) {
  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  // A markdown table (header row + |---|---| separator) only counts as
  // filled if a data row after the separator has a non-empty cell —
  // the header row's own column names ("Term", "Definition", ...) are
  // boilerplate, not project content.
  if (lines.length >= 2 && isTableSeparatorLine(lines[1])) {
    return lines.slice(2).some((row) => {
      const cells = row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      return cells.some((cell) => cell.length > 0);
    });
  }

  return true;
}

/**
 * A memory file (e.g. memory/PROJECT.md) only counts as "filled" when at
 * least one `## Section` actually has content — not just headers plus the
 * boilerplate table skeleton the scaffolded template ships with. Length
 * and keyword heuristics false-positive on that exact template.
 */
export async function isMemoryFileFilled(filePath) {
  const raw = await readTextIfExists(filePath);
  if (!raw) return false;
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "");
  const sections = withoutComments.split(/^##\s+.+$/m).slice(1);
  if (sections.length === 0) {
    return withoutComments.replace(/^#\s+.+$/m, "").trim().length > 0;
  }
  return sections.some(sectionHasRealContent);
}

export function parseNodeMajor() {
  const match = /^v(\d+)/.exec(process.version);
  return match ? Number(match[1]) : 0;
}

export function runNodeScript(scriptName, args = [], { cwd = workspaceRoot } = {}) {
  const scriptPath = path.join(cardsSyncDir, scriptName);
  const display = path.relative(workspaceRoot, scriptPath);
  log("→", `node ${display} ${args.join(" ")}`.trim());
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
  });
  if (result.stdout?.length) process.stdout.write(result.stdout);
  if (result.stderr?.length) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

export function runNodeScriptAsync(scriptName, args = [], { cwd = workspaceRoot } = {}) {
  const scriptPath = path.join(cardsSyncDir, scriptName);
  const display = path.relative(workspaceRoot, scriptPath);
  log("→", `node ${display} ${args.join(" ")}`.trim());
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}

export function runHyperionScript(scriptName, args = []) {
  const scriptPath = path.join(scriptDir, scriptName);
  const display = path.relative(workspaceRoot, scriptPath);
  log("→", `node ${display} ${args.join(" ")}`.trim());
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

export async function collectHyperionHealth() {
  const { resolveHyperionPaths } = await import("./paths.mjs");
  const paths = resolveHyperionPaths(workspaceRoot);
  const githubDir = paths.githubDir;
  const projectYml = paths.projectYmlPath;
  const memoryProject = path.join(paths.memoryDir, "PROJECT.md");
  const projectsMap = paths.projectsMapPath;
  const packageJson = path.join(workspaceRoot, "package.json");

  const nodeMajor = parseNodeMajor();
  const repo = detectRepoFromGit();
  const token = process.env.PROJECT_SYNC_TOKEN || process.env.GITHUB_TOKEN || detectTokenFromGhCli();

  const hasGithubDir = await pathExists(githubDir);
  const hasProjectYml = await pathExists(projectYml);
  const hasProjectsMap = await pathExists(projectsMap);
  const hasPackageJson = await pathExists(packageJson);

  const memoryFilled = await isMemoryFileFilled(memoryProject);

  const issues = [];
  const warnings = [];

  if (!hasGithubDir) {
    issues.push(
      paths.kitRootRel
        ? `Missing kit .github/ under \`${paths.kitRootRel}/\` — copy the Hyperion folder.`
        : "Missing `.github/` — copy the Hyperion kit into this repository (or use nested `Hyperion/` + `npm run hyperion:init -- --adopt`)."
    );
  }
  if (nodeMajor < 20) issues.push(`Node.js 20+ required (current: ${process.version}).`);
  if (!hasPackageJson) warnings.push("No root `package.json` — npm shortcuts unavailable.");
  if (!hasProjectYml) warnings.push("No `.github/project.yml` — run /setup or `hyperion:init -- --adopt`.");
  if (!memoryFilled) {
    warnings.push(
      `\`${path.relative(workspaceRoot, memoryProject).replace(/\\/g, "/")}\` empty or template — fill for better agent context.`
    );
  }
  if (!repo) warnings.push("No git remote `origin` — cards sync cannot auto-detect repository.");
  if (!token) warnings.push("No GitHub token — run `gh auth login` or set PROJECT_SYNC_TOKEN.");
  if (!hasProjectsMap) {
    issues.push(`Missing \`${path.relative(workspaceRoot, projectsMap).replace(/\\/g, "/")}\`.`);
  }

  return {
    nodeMajor,
    repo,
    token,
    hasGithubDir,
    hasProjectYml,
    hasProjectsMap,
    hasPackageJson,
    memoryFilled,
    layout: paths.layout,
    kitRootRel: paths.kitRootRel,
    cardsPrefix: paths.cardsPrefix,
    issues,
    warnings,
  };
}
