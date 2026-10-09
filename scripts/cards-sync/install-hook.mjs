import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const CARDS_MARKER = "# hyperion-cards-validate";
const RULES_MARKER = "# hyperion-check-rules";

/**
 * Build pre-commit hook body for cards validation + runtime rules drift check.
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
`;
}

/** A managed section runs from its marker line to the first `fi` line after it. */
const sectionPattern = (marker) => new RegExp(`^${marker}\\r?\\n[\\s\\S]*?^fi\\r?$`, "m");

/**
 * Hook content after installing the Hyperion sections: sections already in the
 * hook are rewritten in place (so older installs pick up fixes), missing ones
 * are appended, and anything else in the hook is left untouched.
 */
export function mergePreCommitHook(existing, hookBody) {
  const current = existing.trim();
  if (!current.includes(CARDS_MARKER) && !current.includes(RULES_MARKER)) {
    return current ? `${current}\n\n${hookBody.trim()}` : hookBody.trim();
  }
  let merged = current;
  for (const marker of [CARDS_MARKER, RULES_MARKER]) {
    const section = hookBody.match(sectionPattern(marker))[0];
    merged = sectionPattern(marker).test(merged) ? merged.replace(sectionPattern(marker), () => section) : `${merged}\n\n${section}`;
  }
  return merged;
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

async function main() {
  const workspaceRoot = process.cwd();
  const argYes = process.argv.includes("--yes");

  const hooksDir = resolveHooksDir(workspaceRoot);
  if (!hooksDir) {
    console.error("[install-hook] Not a git repository — init git first.");
    process.exit(1);
  }
  const hookPath = path.join(hooksDir, "pre-commit");

  const paths = resolveHyperionPaths(workspaceRoot);
  const hookBody = buildPreCommitHookBody(paths);

  let existing = "";
  try {
    existing = await fs.readFile(hookPath, "utf8");
  } catch {}

  const hasHyperion = existing.includes(CARDS_MARKER) || existing.includes(RULES_MARKER);

  if (existing.trim() && !argYes && !hasHyperion) {
    console.log("[install-hook] pre-commit hook already exists with custom content.");
    console.log("[install-hook] Re-run with --yes to append Hyperion validation block.");
    process.exit(1);
  }

  const merged = `${mergePreCommitHook(existing, hookBody)}\n`;
  if (merged === existing) {
    console.log("[install-hook] Hyperion pre-commit hook already installed (cards + rules).");
    return;
  }

  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(hookPath, merged, "utf8");

  try {
    await fs.chmod(hookPath, 0o755);
  } catch {}

  console.log(
    hasHyperion
      ? "[install-hook] ✅ pre-commit hook updated (Hyperion sections refreshed to the current kit version)"
      : "[install-hook] ✅ pre-commit hook installed (cards validate + rules regen on commands.yml)"
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error("[install-hook] FATAL:", error.message);
    process.exit(1);
  });
}
