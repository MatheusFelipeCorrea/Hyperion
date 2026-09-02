/**
 * Hyperion kit upgrade — pure helpers (plan managed paths, merge package.json).
 * Client repo stays cwd; --from points at a newer kit checkout.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

/** Directories overwritten from the kit (recursive). */
export const MANAGED_DIRS = [
  "scripts/hyperion",
  "scripts/cards-sync",
  ".github/skills",
  ".github/agents",
  ".github/audits",
  ".github/docs",
  ".github/diagrams",
];

/** Single files overwritten when present in the kit. */
export const MANAGED_FILES = [
  ".github/commands.yml",
  ".github/project.schema.json",
  ".github/project.example.yml",
  ".github/STRUCTURE.md",
  ".github/dependabot.yml",
  ".github/hyperion-origin.json",
  ".github/copilot-instructions.md",
  "CLAUDE.md",
  ".env.example",
  ".cursor/rules/hyperion.mdc",
  "Dockerfile",
  "bin/hyperion",
  "bin/hyperion.cmd",
  ".dockerignore",
];

/** Never overwrite — client-owned. */
export const PRESERVE_PATHS = new Set([
  ".github/project.yml",
  ".env",
]);

/** Prefixes never overwritten. */
export const PRESERVE_PREFIXES = [
  ".github/memory/",
  ".github/cards/",
  ".github/plans/",
  ".github/config/",
  ".github/epics/",
  ".github/features/",
  ".github/stories/",
  ".github/tasks/",
  ".github/_examples/",
];

const KIT_SCRIPT_PREFIXES = ["hyperion:", "cards:", "docs:", "skills:"];

export function normalizeRel(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isPreserved(rel) {
  const n = normalizeRel(rel);
  if (PRESERVE_PATHS.has(n)) return true;
  return PRESERVE_PREFIXES.some((pre) => n === pre.slice(0, -1) || n.startsWith(pre));
}

export function isHyperionWorkflow(rel) {
  const n = normalizeRel(rel);
  return (
    n.startsWith(".github/workflows/") &&
    path.posix.basename(n).startsWith("hyperion-") &&
    (n.endsWith(".yml") || n.endsWith(".yaml"))
  );
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fileSha(p) {
  const buf = await fs.readFile(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function walkFiles(absRoot, relBase = "") {
  const out = [];
  if (!(await pathExists(absRoot))) return out;
  const entries = await fs.readdir(absRoot, { withFileTypes: true });
  for (const ent of entries) {
    const rel = normalizeRel(path.posix.join(relBase.replace(/\\/g, "/"), ent.name));
    const abs = path.join(absRoot, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkFiles(abs, rel)));
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Collect relative paths the kit wants to manage for this upgrade.
 */
export async function collectManagedRels(kitRoot) {
  const rels = new Set();

  for (const dir of MANAGED_DIRS) {
    const abs = path.join(kitRoot, ...dir.split("/"));
    for (const rel of await walkFiles(abs, dir)) {
      if (!isPreserved(rel)) rels.add(rel);
    }
  }

  for (const file of MANAGED_FILES) {
    const abs = path.join(kitRoot, ...file.split("/"));
    if (await pathExists(abs)) rels.add(normalizeRel(file));
  }

  const wfDir = path.join(kitRoot, ".github", "workflows");
  for (const rel of await walkFiles(wfDir, ".github/workflows")) {
    if (isHyperionWorkflow(rel)) rels.add(rel);
  }

  // Any extra .cursor/rules/*.mdc from kit (not only hyperion.mdc)
  const cursorRules = path.join(kitRoot, ".cursor", "rules");
  for (const rel of await walkFiles(cursorRules, ".cursor/rules")) {
    if (rel.endsWith(".mdc") || rel.endsWith(".md")) rels.add(rel);
  }

  return [...rels].sort();
}

/**
 * @typedef {"add" | "update" | "unchanged" | "preserve"} Action
 * @typedef {{ rel: string, action: Action, reason?: string }} PlanItem
 */

/**
 * Build upgrade plan: kit → target.
 */
export async function buildUpgradePlan(kitRoot, targetRoot) {
  const managed = await collectManagedRels(kitRoot);
  /** @type {PlanItem[]} */
  const items = [];

  for (const rel of managed) {
    if (isPreserved(rel)) {
      items.push({ rel, action: "preserve", reason: "client-owned" });
      continue;
    }
    const from = path.join(kitRoot, ...rel.split("/"));
    const to = path.join(targetRoot, ...rel.split("/"));
    const destExists = await pathExists(to);
    if (!destExists) {
      items.push({ rel, action: "add" });
      continue;
    }
    const a = await fileSha(from);
    const b = await fileSha(to);
    items.push({ rel, action: a === b ? "unchanged" : "update" });
  }

  // package.json always considered separately
  const kitPkg = path.join(kitRoot, "package.json");
  const tgtPkg = path.join(targetRoot, "package.json");
  if (await pathExists(kitPkg)) {
    if (!(await pathExists(tgtPkg))) {
      items.push({ rel: "package.json", action: "add", reason: "merge-scripts" });
    } else {
      const kit = JSON.parse(await fs.readFile(kitPkg, "utf8"));
      const tgt = JSON.parse(await fs.readFile(tgtPkg, "utf8"));
      const merged = mergePackageJson(tgt, kit);
      const same = JSON.stringify(tgt) === JSON.stringify(merged);
      items.push({
        rel: "package.json",
        action: same ? "unchanged" : "update",
        reason: "merge hyperion:/cards: scripts",
      });
    }
  }

  return items;
}

/**
 * Merge kit scripts/bin/engines into client package.json without wiping product scripts.
 */
export function mergePackageJson(targetPkg, kitPkg) {
  const out = structuredClone(targetPkg);
  out.scripts = { ...(out.scripts || {}) };
  for (const [k, v] of Object.entries(kitPkg.scripts || {})) {
    if (KIT_SCRIPT_PREFIXES.some((p) => k.startsWith(p)) || k === "test") {
      // Only overwrite test if it already looks like hyperion's combined test
      if (k === "test") {
        const cur = out.scripts.test || "";
        if (!cur || cur.includes("hyperion:test") || cur.includes("cards:test")) {
          out.scripts.test = v;
        }
        continue;
      }
      out.scripts[k] = v;
    }
  }
  if (kitPkg.bin) {
    out.bin = { ...(out.bin || {}), ...kitPkg.bin };
  }
  if (kitPkg.engines?.node && !out.engines?.node) {
    out.engines = { ...(out.engines || {}), node: kitPkg.engines.node };
  }
  if (kitPkg.type && !out.type) out.type = kitPkg.type;
  return out;
}

export async function applyUpgradePlan(
  kitRoot,
  targetRoot,
  items,
  { yes = false, remoteMeta = null, sourceLabel = null } = {}
) {
  const applied = [];
  if (!yes) return applied;

  for (const item of items) {
    if (item.action !== "add" && item.action !== "update") continue;

    if (item.rel === "package.json") {
      const kit = JSON.parse(await fs.readFile(path.join(kitRoot, "package.json"), "utf8"));
      const tgtPath = path.join(targetRoot, "package.json");
      let tgt = {};
      if (await pathExists(tgtPath)) {
        tgt = JSON.parse(await fs.readFile(tgtPath, "utf8"));
      } else {
        tgt = { name: path.basename(targetRoot), private: true };
      }
      const merged = mergePackageJson(tgt, kit);
      await fs.mkdir(path.dirname(tgtPath), { recursive: true });
      await fs.writeFile(tgtPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      applied.push(item.rel);
      continue;
    }

    const from = path.join(kitRoot, ...item.rel.split("/"));
    const to = path.join(targetRoot, ...item.rel.split("/"));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    applied.push(item.rel);
  }

  const meta = {
    upgraded_at: new Date().toISOString(),
    kit_name: "hyperion",
    source: sourceLabel || path.resolve(kitRoot),
  };
  if (remoteMeta?.repo) meta.repo = remoteMeta.repo;
  if (remoteMeta?.ref) meta.ref = remoteMeta.ref;
  if (remoteMeta?.commit) meta.commit = remoteMeta.commit;
  try {
    const kitPkg = JSON.parse(await fs.readFile(path.join(kitRoot, "package.json"), "utf8"));
    meta.kit_description = kitPkg.description || null;
  } catch {
    /* ignore */
  }
  // If local --from, try to record HEAD of that tree
  if (!meta.commit) {
    const head = spawnSync("git", ["-C", kitRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (head.status === 0 && head.stdout?.trim()) {
      meta.commit = head.stdout.trim().toLowerCase();
    }
  }
  const metaPath = path.join(targetRoot, ".github", "hyperion-kit.json");
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  applied.push(".github/hyperion-kit.json");

  return applied;
}

export function summarizePlan(items) {
  const counts = { add: 0, update: 0, unchanged: 0, preserve: 0 };
  for (const i of items) counts[i.action] = (counts[i.action] || 0) + 1;
  return counts;
}
