#!/usr/bin/env node
/**
 * Move card markdown files to the nested-by-parent layout.
 *
 * Dry-run by default, same convention as labels-reset.mjs / sync.mjs's live
 * writes — this moves real files on disk, so it shouldn't run live just
 * because someone ran the bare npm script without reading the docs first.
 *
 * Usage:
 *   node scripts/cards-sync/migrate-layout.mjs           # preview (dry-run)
 *   node scripts/cards-sync/migrate-layout.mjs --yes     # apply
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { listCardsMarkdownFiles, resolveCardRelativePath } from "./lib.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const paths = resolveHyperionPaths(process.cwd());
const workspaceRoot = paths.workspaceRoot;
const cardsRoot = paths.cardsRoot;
const cardsPrefix = paths.cardsPrefix;
const argYes = process.argv.includes("--yes");
const dryRun = !argYes;

if (dryRun) {
  console.log("[migrate-layout] Dry-run mode (pass --yes to apply). Preview only.");
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === "null" || value === "") {
      meta[kv[1]] = null;
      continue;
    }
    value = value.replace(/^["']|["']$/g, "");
    meta[kv[1]] = value;
  }
  return meta;
}

function log(msg) {
  console.log(`[migrate-layout] ${msg}`);
}

const allMd = await listCardsMarkdownFiles(cardsRoot);
if (!allMd.length) {
  log(`No cards found under ${cardsPrefix}/`);
  process.exit(0);
}

let moved = 0;
let skipped = 0;
let conflicts = 0;

for (const file of allMd) {
  const relative = path.relative(workspaceRoot, file).replace(/\\/g, "/");
  // Do not rearrange kit samples — keep _examples/ as didactic tree
  if (relative.includes("/_examples/") || relative.includes("\\_examples\\")) {
    skipped++;
    continue;
  }

  const raw = await fs.readFile(file, "utf8");
  const meta = parseFrontmatter(raw);
  if (!meta?.card_id) {
    log(`SKIP (no card_id): ${relative}`);
    skipped++;
    continue;
  }

  const expected = resolveCardRelativePath({
    type: meta.type || "Story",
    cardId: meta.card_id,
    parent: meta.parent ?? null,
    cardsPrefix,
  });

  if (relative === expected) {
    skipped++;
    continue;
  }

  const destAbs = path.join(workspaceRoot, expected);
  try {
    await fs.access(destAbs);
    log(`CONFLICT (dest exists): ${relative} → ${expected}`);
    conflicts++;
    continue;
  } catch {
    // dest free
  }

  if (dryRun) {
    log(`Would move: ${relative} → ${expected}`);
    moved++;
    continue;
  }

  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  await fs.rename(file, destAbs);
  log(`Moved: ${relative} → ${expected}`);
  moved++;
}

log(
  dryRun
    ? `Dry-run complete. Would move: ${moved}; skip: ${skipped}; conflicts: ${conflicts}`
    : `Done. Moved: ${moved}; skip: ${skipped}; conflicts: ${conflicts}`
);

if (conflicts) process.exit(1);
