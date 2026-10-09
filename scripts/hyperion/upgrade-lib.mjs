/**
 * Hyperion kit upgrade — pure helpers (plan managed paths, merge package.json).
 * Client repo stays cwd; --from points at a newer kit checkout.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { HYPERION_WORKFLOWS, NO_AUTO_REFRESH_MARKER, WORKFLOWS_DIR } from "./pipeline-lib.mjs";

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
  ".github/hyperion-origin.json",
  ".github/copilot-instructions.md",
  ".github/mcp/servers.example.json",
  ".github/mcp/README.md",
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

  // No .github/workflows here: those are the kit's own CI. Product workflows are
  // rendered from scripts/hyperion/templates/workflows by /pipeline (pipeline-apply).

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

  // .gitignore always considered separately (marker-guarded merge, never overwritten wholesale)
  const kitGitignore = path.join(kitRoot, ".gitignore");
  if (await pathExists(kitGitignore)) {
    const kit = await fs.readFile(kitGitignore, "utf8");
    const tgtGitignore = path.join(targetRoot, ".gitignore");
    const tgt = (await pathExists(tgtGitignore)) ? await fs.readFile(tgtGitignore, "utf8") : "";
    const merged = mergeGitignore(tgt, kit);
    items.push({
      rel: ".gitignore",
      action: merged === tgt ? "unchanged" : tgt ? "update" : "add",
      reason: "merge kit-managed ignore rules",
    });
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

const GITIGNORE_MARKER_START =
  "# --- Hyperion kit (managed by hyperion:upgrade — edit the kit's .gitignore, not this block) ---";
const GITIGNORE_MARKER_END = "# --- end Hyperion kit ---";

/**
 * Merge the kit's ignore rules into the client's .gitignore inside a
 * marker-guarded block, leaving everything else the adopter added (their own
 * stack's ignores) untouched. Re-running just replaces the block's contents.
 */
export function mergeGitignore(targetContent, kitContent) {
  const kitBlock = kitContent.trim();
  const startIdx = targetContent.indexOf(GITIGNORE_MARKER_START);
  const endIdx = targetContent.indexOf(GITIGNORE_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = targetContent.slice(0, startIdx).trimEnd();
    const after = targetContent.slice(endIdx + GITIGNORE_MARKER_END.length).replace(/^\s*\n/, "");
    const afterPart = after.trim() ? `\n\n${after.trimEnd()}` : "";
    return `${before}\n\n${GITIGNORE_MARKER_START}\n${kitBlock}\n${GITIGNORE_MARKER_END}${afterPart}\n`;
  }

  const base = targetContent.trimEnd();
  return `${base ? `${base}\n\n` : ""}${GITIGNORE_MARKER_START}\n${kitBlock}\n${GITIGNORE_MARKER_END}\n`;
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

    if (item.rel === ".gitignore") {
      const kit = await fs.readFile(path.join(kitRoot, ".gitignore"), "utf8");
      const tgtPath = path.join(targetRoot, ".gitignore");
      const tgt = (await pathExists(tgtPath)) ? await fs.readFile(tgtPath, "utf8") : "";
      const merged = mergeGitignore(tgt, kit);
      await fs.mkdir(path.dirname(tgtPath), { recursive: true });
      await fs.writeFile(tgtPath, merged, "utf8");
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

  await recordUpgradeChangelog(targetRoot, meta, applied.length);

  return applied;
}

/**
 * Append a short note to the adopter's CHANGELOG (client-owned, never overwritten).
 */
export async function recordUpgradeChangelog(targetRoot, meta, pathCount) {
  const changelogPath = path.join(targetRoot, "CHANGELOG.md");
  let existing = "";
  try {
    existing = await fs.readFile(changelogPath, "utf8");
  } catch {
    existing = "# Changelog\n\nAll notable changes to this project are documented here.\n\n";
  }

  const stamp = meta.upgraded_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const commit = meta.commit ? ` (${String(meta.commit).slice(0, 12)})` : "";
  const line = `- Hyperion kit upgrade ${stamp}${commit} — ${pathCount} paths updated`;

  if (existing.includes(line)) return;

  const unreleased = "## [Unreleased]";
  if (existing.includes(unreleased)) {
    const idx = existing.indexOf(unreleased) + unreleased.length;
    const injected = `${existing.slice(0, idx)}\n\n### Changed\n${line}${existing.slice(idx)}`;
    await fs.writeFile(changelogPath, injected, "utf8");
    return;
  }

  const header = existing.trimEnd();
  await fs.writeFile(
    changelogPath,
    `${header}\n\n## [Unreleased]\n\n### Changed\n${line}\n`,
    "utf8"
  );
}

const REQUIRE_PROJECT_OFF_RE = /CARDS_CI_REQUIRE_PROJECT:\s*["']?false/;

/**
 * The kit's own CI workflows, which hyperion:upgrade used to copy into products.
 * `isKitCopy` tells the kit's copy apart from a product file of the same name
 * rendered by /pipeline (templates never carry these fingerprints).
 */
export const KIT_ONLY_WORKFLOWS = [
  {
    file: HYPERION_WORKFLOWS.validate,
    why: "the kit's CI: runs distribution-purity-check, which fails on a product's real cards and projectNumber",
    isKitCopy: (text) => text.includes("distribution-purity-check"),
  },
  {
    file: HYPERION_WORKFLOWS.syncCards,
    why: `the kit's dispatch-only copy: never syncs on push, and --refresh-sync skips it when it carries ${NO_AUTO_REFRESH_MARKER}`,
    isKitCopy: (text) => text.includes("This repo's own copy is workflow_dispatch-only"),
  },
  {
    file: HYPERION_WORKFLOWS.cardsPrGuard,
    why: "the kit's copy: CARDS_CI_REQUIRE_PROJECT is false, so the board guard passes without a linked GitHub Project",
    isKitCopy: (text) => REQUIRE_PROJECT_OFF_RE.test(text),
  },
  {
    file: HYPERION_WORKFLOWS.cardsPrRecheck,
    why: "the kit's copy: CARDS_CI_REQUIRE_PROJECT is false, so the recheck passes without a linked GitHub Project",
    isKitCopy: (text) => REQUIRE_PROJECT_OFF_RE.test(text),
  },
  {
    file: "hyperion-docker-publish.yml",
    why: "publishes the kit's own hyperion-cli image; no product template exists",
    isKitCopy: () => true,
  },
  {
    file: "hyperion-e2e-cards.yml",
    why: "the kit's opt-in end-to-end test against a disposable GitHub repo; no product template exists",
    isKitCopy: () => true,
  },
];

/**
 * Kit-only workflows a previous hyperion:upgrade copied into targetRoot.
 * @returns {Promise<{ rel: string, why: string }[]>}
 */
export async function detectLeakedKitWorkflows(targetRoot) {
  const found = [];
  for (const wf of KIT_ONLY_WORKFLOWS) {
    const rel = `${WORKFLOWS_DIR}/${wf.file}`;
    let text;
    try {
      text = await fs.readFile(path.join(targetRoot, ...rel.split("/")), "utf8");
    } catch {
      continue;
    }
    if (wf.isKitCopy(text)) found.push({ rel, why: wf.why });
  }
  return found;
}

/** Remediation lines for detectLeakedKitWorkflows results (empty when nothing leaked). */
export function formatLeakedKitWorkflowsHelp(found) {
  if (!found.length) return [];
  return [
    `${found.length} workflow(s) in .github/workflows/ are the kit's own CI, copied by an earlier hyperion:upgrade:`,
    ...found.map((f) => `  - ${f.rel} — ${f.why}`),
    "Delete them, then regenerate the workflows your project.yml (ci.hyperion) asks for from the templates:",
    `  git rm ${found.map((f) => f.rel).join(" ")}`,
    "  npm run hyperion:pipeline-apply -- --yes",
    "pipeline-apply --yes only writes missing files, so nothing else is overwritten. The Docker publish and e2e workflows are kit-only and are not regenerated.",
  ];
}

/** What pipeline-apply's refresh flags rewrite. Must match REFRESH_TARGETS and --refresh-gates in pipeline-apply.mjs. */
export function formatWorkflowRefreshHelp() {
  const wf = (key) => HYPERION_WORKFLOWS[key];
  return [
    "Upgrade never touches .github/workflows/. To bring existing workflows up to the new templates:",
    `  npm run hyperion:pipeline-apply -- --refresh-sync --yes   # rewrites ${wf("syncCards")}, ${wf("cardsPrGuard")}, ${wf("cardsPrRecheck")} (and the GitLab/Azure snippets) when outdated; ${wf("syncCards")} with ${NO_AUTO_REFRESH_MARKER} is left alone`,
    `  npm run hyperion:pipeline-apply -- --refresh-gates --yes  # re-renders ${wf("productCi")} when ci.gates changed (unless it has ${NO_AUTO_REFRESH_MARKER})`,
    `Neither refreshes ${wf("security")} or ${wf("validate")}: to update one, delete it and run npm run hyperion:pipeline-apply -- --yes.`,
  ];
}

export function summarizePlan(items) {
  const counts = { add: 0, update: 0, unchanged: 0, preserve: 0 };
  for (const i of items) counts[i.action] = (counts[i.action] || 0) + 1;
  return counts;
}
