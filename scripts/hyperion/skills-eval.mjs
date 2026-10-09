#!/usr/bin/env node
/**
 * Structural eval for critical skills — golden string / regex checks (not LLM).
 * Run: npm run hyperion:skills-eval
 *
 * Case shape:
 *   { "skill": "folder-name", "mustContain": ["..."], "mustMatch": ["regex"] }
 *   { "file": "relative/path.md", "mustContain": ["..."], "mustMatch": ["regex"] }
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.indexOf("--root");
const root = rootArg === -1 ? join(__dirname, "../..") : resolve(process.argv[rootArg + 1] || ".");
const evalRoot = join(root, ".github/skills/eval");

function walkSkills(dir, map = new Map()) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "eval") continue;
      walkSkills(p, map);
      continue;
    }
    if (name === "SKILL.md") {
      const folder = dirname(p).split(/[/\\]/).pop();
      map.set(folder, p);
    }
  }
  return map;
}

function resolveCasePath(c, skills) {
  if (c.file) {
    const abs = join(root, c.file);
    return existsSync(abs) ? abs : null;
  }
  return skills.get(c.skill) || null;
}

function caseLabel(c) {
  return c.file || c.skill || "(unknown)";
}

const casesPath = join(evalRoot, "cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const skills = walkSkills(join(root, ".github/skills"));

let failed = 0;
for (const c of cases) {
  const path = resolveCasePath(c, skills);
  if (!path) {
    console.error(`FAIL ${caseLabel(c)}: target not found`);
    failed++;
    continue;
  }
  const text = readFileSync(path, "utf8");
  for (const needle of c.mustContain || []) {
    if (!text.includes(needle)) {
      console.error(`FAIL ${caseLabel(c)}: missing "${needle}"`);
      failed++;
    }
  }
  for (const pattern of c.mustMatch || []) {
    let re;
    try {
      re = new RegExp(pattern, "m");
    } catch (err) {
      console.error(`FAIL ${caseLabel(c)}: invalid mustMatch /${pattern}/ (${err.message})`);
      failed++;
      continue;
    }
    if (!re.test(text)) {
      console.error(`FAIL ${caseLabel(c)}: mustMatch /${pattern}/`);
      failed++;
    }
  }
}

if (failed) {
  console.error(`\nskills:eval FAILED (${failed} checks)`);
  process.exit(1);
}

console.log(`skills:eval OK (${cases.length} cases)`);
