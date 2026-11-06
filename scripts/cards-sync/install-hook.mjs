import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const CARDS_MARKER = "# hyperion-cards-validate";
const RULES_MARKER = "# hyperion-check-rules";
const ENV_MARKER = "# hyperion-refuse-env";
const SPEC_MARKER = "# hyperion-warn-card-spec";
const COMMIT_MSG_MARKER = "# hyperion-commit-msg";
const PRE_PUSH_MARKER = "# hyperion-pre-push";

const PRE_COMMIT_MARKERS = [CARDS_MARKER, RULES_MARKER, ENV_MARKER, SPEC_MARKER];

/**
 * Build pre-commit hook body for cards validation, rules regen, .env refuse,
 * and CARD_ID/spec warn (no branch-naming gate — Hyperion does not enforce AI-Native names).
 * @param {{ cardsPrefix: string, kitRootRel: string }} paths
 */
export function buildPreCommitHookBody({ cardsPrefix, kitRootRel }) {
  const cardsGrepPattern = `^${cardsPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*\\.md$`;
  const validateScript = kitRootRel
    ? `${kitRootRel}/scripts/cards-sync/validate.mjs`
    : "scripts/cards-sync/validate.mjs";
  const commandsGrep = kitRootRel
    ? `^${kitRootRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.github/commands\\.yml$`
    : "^\\.github/commands\\.yml$";
  const generateRules = kitRootRel
    ? `${kitRootRel}/scripts/hyperion/generate-runtime-rules.mjs`
    : "scripts/hyperion/generate-runtime-rules.mjs";
  const specsPrefix = kitRootRel ? `${kitRootRel}/.github/plans/specs` : ".github/plans/specs";
  const cardsFindPrefix = cardsPrefix;

  return `#!/bin/sh
${CARDS_MARKER}
changed=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACM | grep '${cardsGrepPattern}' || true)
if [ -n "$changed" ]; then
  echo "[Hyperion] Validating staged card files..."
  node ${validateScript} || exit 1
fi

${RULES_MARKER}
cmd_changed=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACM | grep '${commandsGrep}' || true)
if [ -n "$cmd_changed" ]; then
  echo "[Hyperion] Regenerating runtime rules from commands.yml..."
  node ${generateRules} || exit 1
  git add CLAUDE.md .github/copilot-instructions.md .cursor/rules/hyperion.mdc scripts/hyperion/help.mjs 2>/dev/null || true
fi

${ENV_MARKER}
env_staged=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACM | grep -E '(^|/)\\.env$|(^|/)\\.env\\.' | grep -vE '\\.(example|sample|template)$' || true)
if [ -n "$env_staged" ]; then
  echo ""
  echo "[Hyperion] REFUSED: .env files must not be committed"
  echo "$env_staged" | sed 's/^/  - /'
  echo "  Unstage with: git restore --staged <file>"
  echo "  Keep secrets in .env (gitignored) or a secret manager."
  echo ""
  exit 1
fi

${SPEC_MARKER}
branch=$(git symbolic-ref --short HEAD 2>/dev/null || true)
card_id=$(printf '%s' "$branch" | grep -oE '[A-Z][A-Z0-9]+(-[A-Z0-9]+){1,}' | head -1 || true)
if [ -n "$card_id" ]; then
  spec_dir="${specsPrefix}/$card_id"
  card_hit=$(git -c core.quotePath=false ls-files '${cardsFindPrefix}' | grep -F "$card_id" | head -1 || true)
  if [ ! -d "$spec_dir" ] && [ -z "$card_hit" ]; then
    echo ""
    echo "[Hyperion] WARN: branch mentions $card_id but no card/spec was found"
    echo "  Expected card under ${cardsFindPrefix}/ or spec at $spec_dir/"
    echo "  Create/refine with /refine or /spec — commit is not blocked."
    echo ""
  elif [ ! -d "$spec_dir" ]; then
    echo ""
    echo "[Hyperion] WARN: card $card_id found but no acceptance spec at $spec_dir/"
    echo "  Prefer /spec before large implementation — commit is not blocked."
    echo ""
  fi
fi
`;
}

/**
 * Conventional Commits with required scope (card id or area): type(card): subject
 */
export function buildCommitMsgHookBody() {
  const types = "feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert";
  return `#!/bin/sh
${COMMIT_MSG_MARKER}
msg_file="$1"
first_line=$(grep -v '^#' "$msg_file" | head -1 | sed 's/[[:space:]]*$//')
if [ -z "$first_line" ]; then
  exit 0
fi
case "$first_line" in
  Merge\\ *|Revert\\ *) exit 0 ;;
esac
if ! printf '%s' "$first_line" | grep -qE "^(${types})\\([^)]+\\)!?: .+$"; then
  echo ""
  echo "[Hyperion] REFUSED: commit message must be type(scope): subject"
  echo "  Example: feat(PROJ-S1): add Google sign-in"
  echo "  Types: feat fix docs style refactor test chore perf ci build revert"
  echo "  Scope: CARD_ID when you have one, otherwise a short English area (auth, cards-sync)"
  echo "  Received: $first_line"
  echo ""
  exit 1
fi
branch=$(git symbolic-ref --short HEAD 2>/dev/null || true)
card_id=$(printf '%s' "$branch" | grep -oE '[A-Z][A-Z0-9]+(-[A-Z0-9]+){1,}' | head -1 || true)
if [ -n "$card_id" ]; then
  scope=$(printf '%s' "$first_line" | sed -E "s/^(${types})\\(([^)]+)\\)!?: .*/\\2/")
  if [ "$scope" != "$card_id" ]; then
    echo "[Hyperion] WARN: branch has $card_id but commit scope is '$scope' — prefer type($card_id): …"
  fi
fi
`;
}

/**
 * A managed section runs from its `# hyperion-…` marker through the line before
 * the next Hyperion marker (or end of string). Nested `if`/`fi` are fine.
 */
function extractSection(hookBody, marker) {
  const start = hookBody.indexOf(marker);
  if (start < 0) return null;
  const from = hookBody.slice(start);
  const lines = from.split(/\r?\n/);
  let depth = 0;
  let lastFi = 0;
  let seenIf = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0 && /^# hyperion-\w/.test(line.trim())) break;
    const t = line.trim();
    if (/^if\b/.test(t)) {
      depth++;
      seenIf = true;
    } else if (t === "fi") {
      depth--;
      if (seenIf && depth === 0) lastFi = i;
    }
  }
  if (!seenIf) return from.replace(/\s+$/, "");
  return lines.slice(0, lastFi + 1).join("\n");
}

/**
 * Hook content after installing the Hyperion sections: sections already in the
 * hook are rewritten in place (so older installs pick up fixes), missing ones
 * are appended, and anything else in the hook is left untouched.
 */
export function mergePreCommitHook(existing, hookBody) {
  const current = existing.replace(/\r\n/g, "\n").trim();
  const body = hookBody.replace(/\r\n/g, "\n");
  const hasAny = PRE_COMMIT_MARKERS.some((m) => current.includes(m));
  if (!hasAny) {
    return current ? `${current}\n\n${body.trim()}` : body.trim();
  }
  let merged = current;
  for (const marker of PRE_COMMIT_MARKERS) {
    const section = extractSection(body, marker);
    if (!section) continue;
    const prev = extractSection(merged, marker);
    // Replacement must be a function: section text contains `$changed` etc., and
    // String.replace would treat `$` patterns as substitution tokens.
    merged = prev ? merged.replace(prev, () => section) : `${merged}\n\n${section}`;
  }
  return merged.replace(/\s+$/, "");
}

export function mergeCommitMsgHook(existing, hookBody) {
  const current = existing.replace(/\r\n/g, "\n").trim();
  const full = hookBody.replace(/\r\n/g, "\n").trim();
  const section = extractSection(full, COMMIT_MSG_MARKER) || full;
  if (!current) return full;
  if (!current.includes(COMMIT_MSG_MARKER)) {
    return `${current}\n\n${section}`;
  }
  const prev = extractSection(current, COMMIT_MSG_MARKER);
  return (prev ? current.replace(prev, () => section) : `${current}\n\n${section}`).replace(/\s+$/, "");
}

/**
 * Stack-adaptive pre-push: delegates to pre-push-check.mjs (build/test by language).
 */
export function buildPrePushHookBody({ kitRootRel }) {
  const script = kitRootRel
    ? `${kitRootRel}/scripts/hyperion/pre-push-check.mjs`
    : "scripts/hyperion/pre-push-check.mjs";
  // if/else/fi so extractSection bounds the managed block (keeps trailing custom lines).
  return `#!/bin/sh
${PRE_PUSH_MARKER}
if [ "\${SKIP_PREPUSH:-0}" = "1" ]; then
  echo "[Hyperion] pre-push skipped (SKIP_PREPUSH=1). CI still validates."
  exit 0
else
  node ${script} || exit 1
fi
`;
}

export function mergePrePushHook(existing, hookBody) {
  const current = existing.replace(/\r\n/g, "\n").trim();
  const full = hookBody.replace(/\r\n/g, "\n").trim();
  const section = extractSection(full, PRE_PUSH_MARKER) || full;
  if (!current) return full;
  if (!current.includes(PRE_PUSH_MARKER)) {
    return `${current}\n\n${section}`;
  }
  const prev = extractSection(current, PRE_PUSH_MARKER);
  return (prev ? current.replace(prev, () => section) : `${current}\n\n${section}`).replace(/\s+$/, "");
}

/**
 * Resolve the real hooks directory via git itself — works for a normal
 * clone, a git worktree, and a submodule alike, where `.git` may be a
 * file (not a directory) pointing at the actual git dir elsewhere.
 */
function resolveHooksDir(workspaceRoot) {
  try {
    const gitPath = execSync("git rev-parse --git-path hooks", {
      encoding: "utf8",
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return path.isAbsolute(gitPath) ? gitPath : path.join(workspaceRoot, gitPath);
  } catch {
    return null;
  }
}

async function writeHook(hookPath, content) {
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  try {
    await fs.chmod(hookPath, 0o755);
  } catch {
    /* Windows */
  }
}

async function main() {
  const workspaceRoot = process.cwd();
  const argYes = process.argv.includes("--yes");

  const hooksDir = resolveHooksDir(workspaceRoot);
  if (!hooksDir) {
    console.error("[install-hook] Not a git repository — init git first.");
    process.exit(1);
  }
  const preCommitPath = path.join(hooksDir, "pre-commit");
  const commitMsgPath = path.join(hooksDir, "commit-msg");
  const prePushPath = path.join(hooksDir, "pre-push");

  const paths = resolveHyperionPaths(workspaceRoot);
  const preCommitBody = buildPreCommitHookBody(paths);
  const commitMsgBody = buildCommitMsgHookBody();
  const prePushBody = buildPrePushHookBody(paths);

  let existingPre = "";
  try {
    existingPre = (await fs.readFile(preCommitPath, "utf8")).replace(/\r\n/g, "\n");
  } catch {
    /* missing */
  }

  const hasHyperionPre = PRE_COMMIT_MARKERS.some((m) => existingPre.includes(m));

  if (existingPre.trim() && !argYes && !hasHyperionPre) {
    console.log("[install-hook] pre-commit hook already exists with custom content.");
    console.log("[install-hook] Re-run with --yes to append Hyperion validation block.");
    process.exit(1);
  }

  const mergedPre = `${mergePreCommitHook(existingPre, preCommitBody)}\n`;
  const preChanged = mergedPre !== (existingPre.endsWith("\n") ? existingPre : existingPre ? `${existingPre}\n` : "");
  if (preChanged) {
    await writeHook(preCommitPath, mergedPre);
  }

  let existingMsg = "";
  try {
    existingMsg = (await fs.readFile(commitMsgPath, "utf8")).replace(/\r\n/g, "\n");
  } catch {
    /* missing */
  }

  if (existingMsg.trim() && !argYes && !existingMsg.includes(COMMIT_MSG_MARKER)) {
    console.log("[install-hook] commit-msg hook already exists with custom content.");
    console.log("[install-hook] Re-run with --yes to append Hyperion Conventional Commits check.");
    process.exit(1);
  }

  const mergedMsg = `${mergeCommitMsgHook(existingMsg, commitMsgBody)}\n`;
  const msgChanged = mergedMsg !== (existingMsg.endsWith("\n") ? existingMsg : existingMsg ? `${existingMsg}\n` : "");
  if (msgChanged) {
    await writeHook(commitMsgPath, mergedMsg);
  }

  let existingPush = "";
  try {
    existingPush = (await fs.readFile(prePushPath, "utf8")).replace(/\r\n/g, "\n");
  } catch {
    /* missing */
  }

  if (existingPush.trim() && !argYes && !existingPush.includes(PRE_PUSH_MARKER)) {
    console.log("[install-hook] pre-push hook already exists with custom content.");
    console.log("[install-hook] Re-run with --yes to append Hyperion stack-adaptive build/test check.");
    process.exit(1);
  }

  const mergedPush = `${mergePrePushHook(existingPush, prePushBody)}\n`;
  const pushChanged = mergedPush !== (existingPush.endsWith("\n") ? existingPush : existingPush ? `${existingPush}\n` : "");
  if (pushChanged) {
    await writeHook(prePushPath, mergedPush);
  }

  if (!preChanged && !msgChanged && !pushChanged) {
    console.log("[install-hook] Hyperion hooks already installed (pre-commit + commit-msg + pre-push).");
    return;
  }

  const parts = [];
  if (preChanged) {
    parts.push(
      hasHyperionPre
        ? "pre-commit updated (.env refuse + card/spec warn + cards/rules)"
        : "pre-commit installed (.env refuse + card/spec warn + cards/rules)"
    );
  }
  if (msgChanged) {
    parts.push(
      existingMsg.includes(COMMIT_MSG_MARKER)
        ? "commit-msg updated (type(scope): subject)"
        : "commit-msg installed (type(scope): subject)"
    );
  }
  if (pushChanged) {
    parts.push(
      existingPush.includes(PRE_PUSH_MARKER)
        ? "pre-push updated (stack-adaptive build/test)"
        : "pre-push installed (stack-adaptive build/test)"
    );
  }
  console.log(`[install-hook] ✅ ${parts.join("; ")}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error("[install-hook] FATAL:", error.message);
    process.exit(1);
  });
}
