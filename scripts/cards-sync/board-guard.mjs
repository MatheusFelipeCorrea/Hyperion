/**
 * Shared board ↔ repo alignment helpers for ci-sync and PR guard.
 */
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** Frontmatter fields compared for directional drift (board vs git). */
export const SYNC_FIELDS = [
  "status",
  "type",
  "priority",
  "sprint",
  "story_points",
  "reporter",
  "parent",
  "due_date",
  "categories",
  "board_sync_at",
];

/** Human label for the remote board backend. */
export function boardLabel(backend) {
  switch (String(backend || "github").toLowerCase()) {
    case "jira":
      return "Jira board";
    case "gitlab":
      return "GitLab board";
    case "linear":
      return "Linear board";
    case "azure":
    case "azure-devops":
      return "Azure DevOps board";
    default:
      return "GitHub Project board";
  }
}

/** Minimal frontmatter parser for guard comparisons. */
export function parseFrontmatterForGuard(content) {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const meta = {};
  let currentKey = null;
  let currentArray = null;

  for (const line of match[1].split("\n")) {
    const trimmed = line.trimEnd();

    if (/^\s*-\s+/.test(trimmed) && currentKey && currentArray !== null) {
      const value = trimmed.replace(/^\s*-\s+/, "").replace(/^["']|["']$/g, "").trim();
      if (value) currentArray.push(value);
      continue;
    }

    if (currentKey && currentArray !== null) {
      meta[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    const kvMatch = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    if (value === "") {
      currentKey = key;
      currentArray = [];
      continue;
    }

    if (value === "null") {
      meta[key] = null;
      continue;
    }

    const inlineArray = value.match(/^\[([^\]]*)\]$/);
    if (inlineArray) {
      meta[key] = inlineArray[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }

    meta[key] = value.replace(/^["']|["']$/g, "");
  }

  if (currentKey && currentArray !== null) meta[currentKey] = currentArray;
  return meta;
}

export function normalizeSyncFieldValue(field, value) {
  if (value === null || value === undefined || value === "") return null;
  if (field === "categories") {
    const arr = Array.isArray(value) ? value : [value];
    const normalized = arr.map((v) => String(v).trim()).filter(Boolean).sort();
    return normalized.length ? normalized.join("|") : null;
  }
  if (field === "story_points") {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : String(value).trim();
  }
  return String(value).trim();
}

/**
 * Detect board-driven drift: board ≠ HEAD while HEAD still matches base (merge-base / parent).
 * Forward-pending changes (HEAD ≠ base) are allowed through.
 */
export function detectExternalDriftFields(headMeta, baseMeta, boardMeta) {
  const drifts = [];
  const head = headMeta || {};
  const base = baseMeta || {};
  const board = boardMeta || {};

  for (const field of SYNC_FIELDS) {
    const headVal = normalizeSyncFieldValue(field, head[field]);
    const baseVal = normalizeSyncFieldValue(field, base[field]);
    const boardVal = normalizeSyncFieldValue(field, board[field]);

    if (boardVal !== headVal && headVal === baseVal) {
      drifts.push({ field, head: headVal, base: baseVal, board: boardVal });
    }
  }

  return drifts;
}

function gitShowAtRef(workspaceRoot, ref, relativePath) {
  const result = spawnSync("git", ["show", `${ref}:${relativePath}`], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitDiffCardFiles(workspaceRoot, cardsPrefix) {
  const cardsPath = String(cardsPrefix || ".github/cards").replace(/\\/g, "/").replace(/\/+$/, "");
  const diff = spawnSync("git", ["diff", "--name-only", "--", `${cardsPath}/`], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  if (diff.error) {
    return { error: diff.error.message, files: [] };
  }

  const files = (diff.stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.toLowerCase().endsWith(".md"));

  return { files };
}

/**
 * Resolve git ref for "before this change" comparison.
 * @param {"pr"|"main-pre-forward"|"post-forward"} context
 */
export function resolveGuardBaseRef(workspaceRoot, context = "main-pre-forward") {
  if (context === "post-forward") return "HEAD";

  const fromEnv = process.env.CARDS_GUARD_BASE_REF || process.env.GITHUB_BASE_SHA || process.env.GITHUB_EVENT_BEFORE;
  if (fromEnv && !/^0+$/.test(String(fromEnv).replace(/[^0-9a-f]/gi, ""))) {
    return fromEnv;
  }

  const tryMergeBase = (targetRef) => {
    const result = spawnSync("git", ["merge-base", "HEAD", targetRef], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    return null;
  };

  if (context === "pr") {
    const targetBranch = process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
    if (targetBranch) {
      const mb = tryMergeBase(`origin/${targetBranch}`) || tryMergeBase(targetBranch);
      if (mb) return mb;
    }
    const mbMain = tryMergeBase("origin/main") || tryMergeBase("main");
    if (mbMain) return mbMain;
  }

  const parent = spawnSync("git", ["rev-parse", "HEAD~1"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (parent.status === 0 && parent.stdout.trim()) return parent.stdout.trim();

  return "HEAD";
}

/**
 * After reverse sync: distinguish external board drift from forward-pending git changes.
 * @param {"pr"|"main-pre-forward"|"post-forward"} context
 */
export async function checkDirectionalBoardAlignment(
  workspaceRoot,
  cardsPrefix,
  { context = "main-pre-forward", baseRef = null, strictGit = false } = {}
) {
  const diffResult = gitDiffCardFiles(workspaceRoot, cardsPrefix);

  if (diffResult.error) {
    if (strictGit) {
      return {
        aligned: false,
        files: [],
        externalDrifts: [],
        gitAvailable: false,
        warning: diffResult.error,
      };
    }
    return {
      aligned: true,
      files: [],
      externalDrifts: [],
      gitAvailable: false,
      warning: diffResult.error,
      skipped: true,
    };
  }

  if (context === "post-forward") {
    return {
      aligned: diffResult.files.length === 0,
      files: diffResult.files,
      externalDrifts: [],
      gitAvailable: true,
    };
  }

  const resolvedBase = baseRef || resolveGuardBaseRef(workspaceRoot, context);
  const externalDrifts = [];
  const driftFiles = [];

  for (const relativeFile of diffResult.files) {
    const normalized = relativeFile.replace(/\\/g, "/");
    const headRaw = gitShowAtRef(workspaceRoot, "HEAD", normalized);
    const baseRaw = gitShowAtRef(workspaceRoot, resolvedBase, normalized);

    if (!headRaw) continue;

    let boardRaw;
    try {
      boardRaw = await fs.readFile(path.join(workspaceRoot, normalized), "utf8");
    } catch {
      continue;
    }

    const headMeta = parseFrontmatterForGuard(headRaw);
    const baseMeta = baseRaw ? parseFrontmatterForGuard(baseRaw) : null;
    const boardMeta = parseFrontmatterForGuard(boardRaw);

    if (!headMeta || !boardMeta) continue;

    const fields = detectExternalDriftFields(headMeta, baseMeta, boardMeta);
    if (fields.length) {
      driftFiles.push(normalized);
      externalDrifts.push({ file: normalized, fields });
    }
  }

  return {
    aligned: externalDrifts.length === 0,
    files: driftFiles.length ? driftFiles : diffResult.files,
    externalDrifts,
    gitAvailable: true,
    baseRef: resolvedBase,
  };
}

/**
 * Print drift help for CI / PR contexts.
 * @param {"pr"|"main-pre-forward"|"post-forward"} context
 */
export function printBoardDriftHelp(changedFiles, backend, context = "main-pre-forward", log = console.log, externalDrifts = []) {
  const label = boardLabel(backend);

  log("");
  log("=== BOARD DRIFT DETECTED ===");

  if (context === "pr") {
    log(`The ${label} has external changes not reflected in this PR branch.`);
    log("(Forward-pending card edits in this PR are allowed — only board moves block merge.)");
    log("");
    log("Merge is blocked until you pull board state into this branch:");
    log("  npm run cards:reverse");
    log("  git add .github/cards/");
    log('  git commit -m "chore(cards): pull board state into PR"');
    log("  git push");
  } else if (context === "post-forward") {
    log(`After forward sync, the ${label} still differs from committed cards.`);
    log("This may indicate a partial sync, API lag, or concurrent board edits.");
  } else {
    log(`The ${label} has external changes not in this commit.`);
    log("(Intentional card edits waiting for forward sync are allowed.)");
    log("");
    log("If the board moved independently, run locally:");
    log("  npm run cards:reverse");
    log("  git add .github/cards/");
    log('  git commit -m "chore(cards): pull board state before sync"');
  }

  if (externalDrifts.length) {
    log("");
    log("External drift (board changed, branch did not):");
    for (const entry of externalDrifts) {
      for (const f of entry.fields) {
        log(`  - ${entry.file} → ${f.field}: branch=${f.head ?? "null"} board=${f.board ?? "null"}`);
      }
    }
  } else {
    log("");
    log("Changed card files after reverse pull:");
    for (const f of changedFiles) log(`  - ${f}`);
  }
  log("");
}

/**
 * Evaluate alignment after reverse sync (directional or post-forward simple diff).
 * @returns {{ ok: boolean, skipped?: boolean }}
 */
export function evaluateBoardAlignment(alignment, { backend, context = "main-pre-forward", logFn } = {}) {
  const log = logFn || ((msg) => console.log(msg));

  if (alignment.skipped || alignment.warning) {
    const strict = String(process.env.CARDS_CI_STRICT_GIT || "false").toLowerCase() === "true";
    if (strict && alignment.warning) {
      log(`FATAL: git unavailable (${alignment.warning}) — board guard requires git`);
      return { ok: false };
    }
    log(`WARN: git diff unavailable (${alignment.warning}) — skipping board guard`);
    return { ok: true, skipped: true };
  }

  if (!alignment.aligned) {
    printBoardDriftHelp(
      alignment.files,
      backend,
      context,
      (msg) => {
        if (msg === "") log("");
        else log(msg);
      },
      alignment.externalDrifts || []
    );
    return { ok: false };
  }

  const baseNote = alignment.baseRef ? ` (base ${alignment.baseRef.slice(0, 7)})` : "";
  log(`Board guard passed${baseNote} — no external drift (${context}).`);
  return { ok: true };
}

/** @deprecated use checkDirectionalBoardAlignment — kept for simple diff listing */
export function listCardDiffFilesAfterReverse(workspaceRoot, cardsPrefix) {
  return gitDiffCardFiles(workspaceRoot, cardsPrefix);
}
