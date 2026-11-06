#!/usr/bin/env node
/**
 * Sync runtime command tables from .github/commands.yml
 * Run: npm run hyperion:generate-rules
 * Check: npm run hyperion:check-rules
 *        npm run hyperion:check-rules -- --root <kit-root>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ciErrorList } from "./ci-annotate.mjs";
import { rootArg } from "./cli-args.mjs";
import {
  AGENTS_MARKER_END,
  AGENTS_MARKER_START,
  buildAgentsSection,
  buildHelpContent,
  buildLanguageSection,
  buildSkillIndex,
  LANGUAGE_MARKER_END,
  LANGUAGE_MARKER_START,
  loadCommands,
  normalizeEol,
  replaceMarkedSection,
  replaceTextSection,
  runtimeTargets,
  SKILLS_MARKER_END,
  SKILLS_MARKER_START,
  buildSkillsSection,
} from "./commands-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes("--check");
const root = rootArg(join(__dirname, "../.."));

const { commands, npmShortcuts } = loadCommands(root);
const skillIndex = buildSkillIndex(root);

function applyCatalogSections(content, syncCatalog) {
  if (!syncCatalog) return content;
  let next = replaceTextSection(
    content,
    buildSkillsSection(root),
    SKILLS_MARKER_START,
    SKILLS_MARKER_END
  );
  next = replaceTextSection(next, buildAgentsSection(root), AGENTS_MARKER_START, AGENTS_MARKER_END);
  next = replaceTextSection(next, buildLanguageSection(), LANGUAGE_MARKER_START, LANGUAGE_MARKER_END);
  return next;
}

const outputs = [
  {
    path: join(root, "scripts/hyperion/help.mjs"),
    content: normalizeEol(buildHelpContent(commands, npmShortcuts)),
  },
  ...runtimeTargets(root).map((target) => {
    const current = readFileSync(target.path, "utf8");
    const rows = target.buildRows(commands, skillIndex);
    let content = replaceMarkedSection(current, rows);
    content = applyCatalogSections(content, target.syncCatalog);
    return {
      path: target.path,
      content: normalizeEol(content),
    };
  }),
];

const drifted = [];

for (const { path, content } of outputs) {
  if (checkOnly) {
    const current = normalizeEol(readFileSync(path, "utf8"));
    if (current !== content) {
      console.error(`Drift detected: ${path.replace(/\\/g, "/")}`);
      drifted.push(relative(join(__dirname, "../.."), path));
    }
    continue;
  }
  writeFileSync(path, content, "utf8");
  console.log(`Updated ${path.replace(/\\/g, "/")}`);
}

if (checkOnly) {
  if (drifted.length) {
    console.error("\nRuntime rules out of sync. Run: npm run hyperion:generate-rules");
    ciErrorList(
      "Runtime rules out of sync",
      drifted.map((file) => ({ file, message: "Generated from .github/commands.yml and the skills catalog, but not regenerated (or edited by hand)." })),
      "Run npm run hyperion:generate-rules and commit the regenerated files together with your .github/commands.yml / skills change."
    );
    process.exit(1);
  }
  console.log("Runtime rules in sync with .github/commands.yml");
} else {
  console.log("\nDone. Commit generated files with commands.yml changes.");
}
