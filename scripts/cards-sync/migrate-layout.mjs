#!/usr/bin/env node
/**
 * Move card markdown files to the nested-by-parent layout.
 *
 * Usage:
 *   node scripts/cards-sync/migrate-layout.mjs           # apply
 *   node scripts/cards-sync/migrate-layout.mjs --dry-run # preview
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { listCardsMarkdownFiles, resolveCardRelativePath } from "./lib.mjs";

const workspaceRoot = process.cwd();
const cardsRoot = path.join(workspaceRoot, ".github", "cards");
const dryRun = process.argv.includes("--dry-run");

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
  log("No cards found under .github/cards/");
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
