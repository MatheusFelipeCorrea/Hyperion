import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const workspaceRoot = process.cwd();
const hookPath = path.join(workspaceRoot, ".git", "hooks", "pre-commit");
const marker = "# hyperion-cards-validate";

const { cardsPrefix, kitRootRel } = resolveHyperionPaths(workspaceRoot);
// cardsPrefix/validateScript account for a nested kit.root layout (e.g.
// "Hyperion/.github/cards", "Hyperion/scripts/cards-sync/validate.mjs") —
// hardcoding the legacy root-layout paths here made the hook a silent
// no-op for nested adopters (grep never matched, script path never found).
const cardsGrepPattern = `^${cardsPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*\\.md$`;
const validateScript = kitRootRel ? `${kitRootRel}/scripts/cards-sync/validate.mjs` : "scripts/cards-sync/validate.mjs";

const hookBody = `#!/bin/sh
${marker}
changed=$(git diff --cached --name-only --diff-filter=ACM | grep '${cardsGrepPattern}' || true)
if [ -n "$changed" ]; then
  echo "[Hyperion] Validating staged card files..."
  node ${validateScript} || exit 1
fi
`;

async function main() {
  const argYes = process.argv.includes("--yes");
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

  if (existing.includes(marker)) {
    console.log("[install-hook] Hyperion pre-commit hook already installed.");
    return;
  }

  if (existing.trim() && !argYes) {
    console.log("[install-hook] pre-commit hook already exists with custom content.");
    console.log("[install-hook] Re-run with --yes to append Hyperion validation block.");
    process.exit(1);
  }

  const merged = existing.trim()
    ? `${existing.trimEnd()}\n\n${hookBody}`
    : hookBody;

  await fs.writeFile(hookPath, merged, "utf8");

  try {
    await fs.chmod(hookPath, 0o755);
  } catch {}

  console.log("[install-hook] ✅ pre-commit hook installed (validates .github/cards/*.md on commit)");
}

main().catch((error) => {
  console.error("[install-hook] FATAL:", error.message);
  process.exit(1);
});
