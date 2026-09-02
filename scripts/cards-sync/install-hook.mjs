import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
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
changed=$(git diff --cached --name-only --diff-filter=ACM | grep '${cardsGrepPattern}' || true)
if [ -n "$changed" ]; then
  echo "[Hyperion] Validating staged card files..."
  node ${validateScript} || exit 1
fi

${RULES_MARKER}
cmd_changed=$(git diff --cached --name-only --diff-filter=ACM | grep '${commandsGrep}' || true)
if [ -n "$cmd_changed" ]; then
  echo "[Hyperion] Regenerating runtime rules from commands.yml..."
  node ${generateRules} || exit 1
  git add CLAUDE.md .github/copilot-instructions.md .cursor/rules/hyperion.mdc scripts/hyperion/help.mjs 2>/dev/null || true
fi
`;
}

async function main() {
  const workspaceRoot = process.cwd();
  const argYes = process.argv.includes("--yes");
  const hookPath = path.join(workspaceRoot, ".git", "hooks", "pre-commit");
  const paths = resolveHyperionPaths(workspaceRoot);
  const hookBody = buildPreCommitHookBody(paths);

  const gitDir = path.join(workspaceRoot, ".git");
  try {
    await fs.stat(gitDir);
  } catch {
    console.error("[install-hook] Not a git repository — init git first.");
    process.exit(1);
  }

  let existing = "";
  try {
    existing = await fs.readFile(hookPath, "utf8");
  } catch {}

  const hasCards = existing.includes(CARDS_MARKER);
  const hasRules = existing.includes(RULES_MARKER);

  if (hasCards && hasRules) {
    console.log("[install-hook] Hyperion pre-commit hook already installed (cards + rules).");
    return;
  }

  if (existing.trim() && !argYes && !(hasCards || hasRules)) {
    console.log("[install-hook] pre-commit hook already exists with custom content.");
    console.log("[install-hook] Re-run with --yes to append Hyperion validation block.");
    process.exit(1);
  }

  let merged = existing.trim();
  if (!hasCards || !hasRules) {
    const block = hookBody.trim();
    merged = merged ? `${merged.trimEnd()}\n\n${block}` : block;
  }

  await fs.writeFile(hookPath, `${merged}\n`, "utf8");

  try {
    await fs.chmod(hookPath, 0o755);
  } catch {}

  console.log("[install-hook] ✅ pre-commit hook installed (cards validate + rules regen on commands.yml)");
}

main().catch((error) => {
  console.error("[install-hook] FATAL:", error.message);
  process.exit(1);
});
