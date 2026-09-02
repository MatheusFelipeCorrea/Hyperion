#!/usr/bin/env node
/**
 * Prose drift guard — catches stale path references docs:check misses (non-markdown links).
 * Run: npm run docs:prose-check
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

/** { pattern, message, glob? } — pattern tested against file content */
const RULES = [
  {
    pattern: /\.github\/instructions\/copilot-instructions\.md/g,
    message: "Copilot instructions moved to .github/copilot-instructions.md",
  },
  {
    pattern: /\.github\/docs\/exemplars\.md/g,
    message: "exemplars moved to .github/docs/reference/exemplars.md",
  },
  {
    pattern: /scripts\/cards-sync\/sync\.mjs.*\b(jira|linear|azure|gitlab)\b/gi,
    message: "Non-GitHub backends live under scripts/cards-sync/backends/",
  },
  {
    pattern: /forward-only.*linear|linear.*forward-only/gi,
    message: "Linear supports reverse sync — remove forward-only claim",
  },
  {
    pattern: /this repo'?s own maintainer dogfoods/gi,
    message: "Remove maintainer-specific CI comment (copied to adopters)",
  },
];

const SCAN_EXT = new Set([".md", ".mdc", ".yml", ".yaml", ".json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "audits/results"]);

const SKIP_FILES = new Set(["CHANGELOG.md"]);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, files);
    } else if ([...SCAN_EXT].some((ext) => name.endsWith(ext)) && !SKIP_FILES.has(name)) {
      files.push(p);
    }
  }
  return files;
}

const files = walk(root);
const hits = [];

for (const file of files) {
  const rel = file.replace(root + "\\", "").replace(root + "/", "");
  const content = readFileSync(file, "utf8");
  for (const rule of RULES) {
    if (rule.pattern.test(content)) {
      hits.push({ file: rel, message: rule.message });
    }
    rule.pattern.lastIndex = 0;
  }
}

if (hits.length) {
  console.error(`docs:prose-check FAILED — ${hits.length} stale reference(s)`);
  for (const h of hits.slice(0, 30)) {
    console.error(`  ${h.file}: ${h.message}`);
  }
  process.exit(1);
}

console.log(`docs:prose-check OK — ${files.length} files, ${RULES.length} rules`);
