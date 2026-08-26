#!/usr/bin/env node
/**
 * Hyperion path resolver — kit may live at repo root (legacy) or under kit.root
 * (preferred adopter layout: produto/Hyperion/).
 *
 * Detection order for kit.root:
 * 1. HYPERION_ROOT env
 * 2. `.github/project.yml` → `kit.root`
 * 3. Auto: `Hyperion/.github/cards` exists → "Hyperion"
 * 4. Else "" (kit files at workspace root — upstream / legacy)
 */
import fs from "node:fs";
import path from "node:path";

function posixJoin(...parts) {
  return parts
    .filter((p) => p !== null && p !== undefined && String(p).length > 0)
    .map((p) => String(p).replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function readKitRootFromProjectYml(projectYmlPath) {
  try {
    const raw = fs.readFileSync(projectYmlPath, "utf8");
    const lines = raw.split(/\r?\n/);
    let inKit = false;
    for (const line of lines) {
      if (/^\s*kit\s*:\s*$/.test(line)) {
        inKit = true;
        continue;
      }
      if (inKit) {
        if (/^\S/.test(line) && !/^\s/.test(line)) break; // next top-level key
        const rootMatch = line.match(/^\s+root\s*:\s*["']?([^\s#"']+)/);
        if (rootMatch) return rootMatch[1].trim();
      }
    }
  } catch {
    // missing
  }
  return null;
}

function normalizeKitRoot(value) {
  if (value === null || value === undefined) return null;
  let v = String(value).trim().replace(/\\/g, "/");
  if (!v || v === "." || v === "./") return "";
  return v.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * @param {string} [workspaceRoot]
 * @returns {{
 *   workspaceRoot: string,
 *   kitRoot: string,
 *   kitRootRel: string,
 *   cardsRoot: string,
 *   cardsPrefix: string,
 *   projectYmlPath: string,
 *   projectsMapPath: string,
 *   plansCardsDir: string,
 *   memoryDir: string,
 *   skillsDir: string,
 *   agentsDir: string,
 *   githubDir: string,
 *   layout: "nested" | "legacy",
 * }}
 */
export function resolveHyperionPaths(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  const productProjectYml = path.join(root, ".github", "project.yml");

  let kitRootRel =
    normalizeKitRoot(process.env.HYPERION_ROOT) ??
    normalizeKitRoot(readKitRootFromProjectYml(productProjectYml));

  if (kitRootRel === null) {
    const nestedCards = path.join(root, "Hyperion", ".github", "cards");
    const legacyCards = path.join(root, ".github", "cards");
    if (fs.existsSync(nestedCards)) kitRootRel = "Hyperion";
    else if (fs.existsSync(legacyCards)) kitRootRel = "";
    else kitRootRel = "";
  }

  const kitRoot = kitRootRel ? path.join(root, kitRootRel) : root;
  const githubDir = path.join(kitRoot, ".github");
  const cardsRoot = path.join(githubDir, "cards");
  const cardsPrefix = kitRootRel
    ? posixJoin(kitRootRel, ".github/cards")
    : ".github/cards";

  // Product contract prefers workspace `.github/project.yml`; fall back to kit copy.
  let projectYmlPath = productProjectYml;
  if (!fs.existsSync(projectYmlPath)) {
    const kitYml = path.join(githubDir, "project.yml");
    if (fs.existsSync(kitYml)) projectYmlPath = kitYml;
  }

  return {
    workspaceRoot: root,
    kitRoot,
    kitRootRel,
    cardsRoot,
    cardsPrefix,
    projectYmlPath,
    projectsMapPath: path.join(cardsRoot, "config", "projects-map.json"),
    plansCardsDir: path.join(githubDir, "plans", "cards"),
    memoryDir: path.join(githubDir, "memory"),
    skillsDir: path.join(githubDir, "skills"),
    agentsDir: path.join(githubDir, "agents"),
    githubDir,
    layout: kitRootRel ? "nested" : "legacy",
  };
}

/** @deprecated alias */
export function resolveHyperionPathsSync(workspaceRoot) {
  return resolveHyperionPaths(workspaceRoot);
}

export { posixJoin };
