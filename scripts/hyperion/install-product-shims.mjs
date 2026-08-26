#!/usr/bin/env node
/**
 * Write product-root shims so Cursor / Claude / Actions see a nested Hyperion kit.
 *
 * Run from the PRODUCT repo root after copying the kit folder:
 *   node Hyperion/scripts/hyperion/install-product-shims.mjs
 *   npm run hyperion:install-shims --prefix Hyperion
 *   npm run hyperion:init -- --adopt
 *
 * Does not overwrite existing product workflows or CLAUDE.md unless --force.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveHyperionPaths } from "./paths.mjs";
import { ok, warn, log, pathExists } from "./lib.mjs";

const force = process.argv.includes("--force");
const kitName = process.argv.includes("--kit")
  ? process.argv[process.argv.indexOf("--kit") + 1]
  : "Hyperion";

const workspaceRoot = process.cwd();

async function writeIfMissing(filePath, contents, label) {
  if ((await pathExists(filePath)) && !force) {
    warn(`Skip existing ${label}: ${path.relative(workspaceRoot, filePath)}`);
    return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  ok(`Wrote ${label}: ${path.relative(workspaceRoot, filePath)}`);
  return true;
}

async function main() {
  log("", `Install product shims (kit folder: ${kitName}/)`);

  const nestedKit = path.join(workspaceRoot, kitName);
  if (!(await pathExists(path.join(nestedKit, ".github", "cards")))) {
    warn(`Expected ${kitName}/.github/cards — copy the Hyperion folder first.`);
    process.exit(1);
  }

  // product project.yml with kit.root
  const projectYml = path.join(workspaceRoot, ".github", "project.yml");
  if (!(await pathExists(projectYml))) {
    const example = path.join(nestedKit, ".github", "project.example.yml");
    let body = await fs.readFile(example, "utf8").catch(() => "version: 1\nname: My Project\n");
    if (!/^\s*kit\s*:/m.test(body)) {
      body = body.replace(
        /^version:\s*\d+\s*$/m,
        `version: 1\n\nkit:\n  root: ${kitName}\n`
      );
      if (!/^\s*kit\s*:/m.test(body)) {
        body = `version: 1\nkit:\n  root: ${kitName}\n\n` + body;
      }
    } else if (!/^\s+root\s*:/m.test(body)) {
      body = body.replace(/^\s*kit\s*:\s*$/m, `kit:\n  root: ${kitName}`);
    }
    await writeIfMissing(projectYml, body, "project.yml");
  } else {
    const raw = await fs.readFile(projectYml, "utf8");
    if (!/^\s*kit\s*:/m.test(raw)) {
      const next = raw.replace(/^version:\s*(\d+)\s*$/m, `version: $1\n\nkit:\n  root: ${kitName}\n`);
      if (force || next !== raw) {
        await fs.writeFile(projectYml, next, "utf8");
        ok("Added kit.root to existing .github/project.yml");
      }
    } else {
      warn("project.yml already has kit: — leave as-is");
    }
  }

  const claudeShim = `# Hyperion (shim)

This product uses the Hyperion kit in \`./${kitName}/\`.

- Full kit instructions: \`${kitName}/CLAUDE.md\`
- Skills: \`${kitName}/.github/skills/\`
- Agents: \`${kitName}/.github/agents/\`
- Cards: \`${kitName}/.github/cards/\`
- Product contract: \`.github/project.yml\` (\`kit.root: ${kitName}\`)

Prefer chat commands (\`/setup\`, \`/refine\`, \`/sync\`, …). Do not scatter kit files into the product root.
`;

  await writeIfMissing(path.join(workspaceRoot, "CLAUDE.md"), claudeShim, "CLAUDE.md shim");

  const cursorShim = `---
description: Hyperion kit pointer (nested under ${kitName}/)
globs: ["**/*"]
alwaysApply: true
---

# Hyperion

The Hyperion agents/skills kit lives in \`./${kitName}/\`.

Before planning or coding with Hyperion commands:
1. Read \`.github/project.yml\` (note \`kit.root: ${kitName}\`).
2. Open skills under \`${kitName}/.github/skills/**/SKILL.md\`.
3. Write cards under \`${kitName}/.github/cards/\` (nested by parent card_id).
4. Do not copy kit files into the product root — keep artifacts inside \`${kitName}/\`.

Full command map: \`${kitName}/CLAUDE.md\` and \`${kitName}/.github/commands.yml\`.
`;

  await writeIfMissing(
    path.join(workspaceRoot, ".cursor", "rules", "hyperion.mdc"),
    cursorShim,
    "Cursor rules shim"
  );

  const paths = resolveHyperionPaths(workspaceRoot);
  ok(`Resolver layout=${paths.layout} cardsPrefix=${paths.cardsPrefix}`);
  log("", "Next: open chat in the product repo → /setup or /migrate");
  log("", "Pipeline optional: ci.policy: skip keeps your existing CI only.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
