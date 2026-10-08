#!/usr/bin/env node
/**
 * Validate all SKILL.md files under .github/skills/
 * Run: npm run skills:validate
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const skillsRoot = join(root, ".github/skills");

const OPS_SKILLS = new Set(["hyperion-ops"]);

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseFrontmatter(text) {
  text = stripBom(text);
  if (!text.startsWith("---")) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;

  const block = match[1];
  const fm = {};

  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (nameMatch) {
    fm.name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  const inlineDesc = block.match(/^description:\s*(.+)$/m);
  if (inlineDesc && !/^>-?\s*$/.test(inlineDesc[1].trim())) {
    fm.description = inlineDesc[1].trim().replace(/^["']|["']$/g, "");
  } else {
    const multiDesc = block.match(/^description:\s*>-?\s*\r?\n((?:[ \t]+.+\r?\n?)+)/m);
    if (multiDesc) {
      fm.description = multiDesc[1]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ");
    }
  }

  return fm;
}

const OUTPUT_RE = /^## Output(\b|\s|\()/m;
/** Fixed language choices (`${OUTPUT_LANGUAGE="pt-BR|en"}`) — skills must read locale/languages from project.yml. */
const FIXED_LANGUAGE_RE = /\$\{[A-Z_]*LANG[A-Z_]*\s*=|\b(?:pt-BR|en|es)\|(?:pt-BR|en|es)\b/;

function walkSkillFiles(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walkSkillFiles(p, files);
      continue;
    }
    if (name === "SKILL.md") files.push(p);
  }
  return files;
}

const files = walkSkillFiles(skillsRoot);
const errors = [];
const names = new Map();

for (const file of files) {
  const rel = file.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").length + 1);
  const folder = dirname(file).split(/[/\\]/).pop();
  const text = readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);

  if (!fm) {
    errors.push(`${rel}: missing YAML frontmatter`);
    continue;
  }
  if (!fm.name?.trim()) {
    errors.push(`${rel}: frontmatter missing 'name'`);
  }
  if (!fm.description?.trim()) {
    errors.push(`${rel}: frontmatter missing 'description'`);
  }
  if (fm.name && fm.name !== folder) {
    errors.push(`${rel}: frontmatter name "${fm.name}" does not match folder "${folder}"`);
  }
  if (!OPS_SKILLS.has(fm.name) && !OUTPUT_RE.test(text)) {
    errors.push(`${rel}: missing "## Output" section`);
  }
  const fixedLang = text.match(FIXED_LANGUAGE_RE);
  if (fixedLang) {
    errors.push(
      `${rel}: fixed language choice "${fixedLang[0]}" — use \`locale\` / \`languages\` from project.yml (see .github/docs/meta/language-policy-en.md)`
    );
  }
  if (fm.name) {
    const prev = names.get(fm.name);
    if (prev) {
      errors.push(`Duplicate skill name "${fm.name}": ${prev} and ${rel}`);
    } else {
      names.set(fm.name, rel);
    }
  }
}

if (errors.length) {
  console.error("skills:validate failed:\n");
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log(`skills:validate OK (${files.length} skills)`);
