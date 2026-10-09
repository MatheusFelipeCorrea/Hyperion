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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ciErrorList } from "./ci-annotate.mjs";

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
const problems = [];
const bad = (c, path, message) => {
  console.error(`FAIL ${caseLabel(c)}: ${message}`);
  problems.push({ file: path ? relative(root, path) : undefined, message: `${caseLabel(c)}: ${message}` });
  failed++;
};
for (const c of cases) {
  const path = resolveCasePath(c, skills);
  if (!path) {
    bad(c, null, "target not found");
    continue;
  }
  const text = readFileSync(path, "utf8");
  for (const needle of c.mustContain || []) {
    if (!text.includes(needle)) bad(c, path, `missing "${needle}"`);
  }
  for (const pattern of c.mustMatch || []) {
    let re;
    try {
      re = new RegExp(pattern, "m");
    } catch (err) {
      bad(c, null, `invalid mustMatch /${pattern}/ (${err.message})`);
      continue;
    }
    if (!re.test(text)) bad(c, path, `mustMatch /${pattern}/`);
  }
}

if (failed) {
  console.error(`\nskills:eval FAILED (${failed} checks)`);
  ciErrorList(
    "Skill eval",
    problems,
    `${failed} check(s) in .github/skills/eval/cases.json failed: a skill lost text the eval expects. Restore it, or update the case if the change was intended. Reproduce: npm run hyperion:skills-eval`
  );
  process.exit(1);
}

console.log(`skills:eval OK (${cases.length} cases)`);
