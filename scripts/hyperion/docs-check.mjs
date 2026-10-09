#!/usr/bin/env node
/**
 * Basic markdown link sanity check + translated doc pairs (.github/docs/translations.json).
 * Run: npm run docs:check
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ciErrorList } from "./ci-annotate.mjs";
import { rootArg } from "./cli-args.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const SKIP = ["http://", "https://", "mailto:", "#"];
const toPosix = (p) => p.replace(/\\/g, "/");

/** Translated doc pairs map, relative to the repo root. */
export const TRANSLATIONS_MAP = ".github/docs/translations.json";

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, files);
    } else if (name.endsWith(".md") || name.endsWith(".mdc")) {
      files.push(p);
    }
  }
  return files;
}

/** Absolute paths of every local markdown link target in a file. */
function linkTargets(file, content) {
  const out = new Set();
  for (const m of content.matchAll(LINK_RE)) {
    const target = m[2].split("#")[0].trim();
    if (!target || SKIP.some((p) => target.startsWith(p))) continue;
    out.add(resolve(dirname(file), target));
  }
  return out;
}

/**
 * Every listed translation must exist and link to each of its counterparts.
 * @returns {{ errors: string[], warnings: string[], pairs: number }}
 */
export function checkTranslations(root) {
  const mapPath = join(root, TRANSLATIONS_MAP);
  if (!existsSync(mapPath)) return { errors: [], warnings: [], pairs: 0 };
  let map;
  try {
    map = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch (e) {
    return { errors: [`${TRANSLATIONS_MAP}: ${e.message}`], warnings: [], pairs: 0 };
  }
  const errors = [];
  const warnings = [];
  const listed = new Set();
  const pairs = Array.isArray(map.pairs) ? map.pairs : [];
  for (const pair of pairs) {
    const entries = Object.entries(pair || {});
    if (entries.length < 2) {
      errors.push(`${TRANSLATIONS_MAP}: pair needs at least two languages: ${JSON.stringify(pair)}`);
      continue;
    }
    for (const [, rel] of entries) listed.add(toPosix(rel));
    for (const [lang, rel] of entries) {
      const abs = resolve(root, rel);
      if (!existsSync(abs)) {
        errors.push(`${rel} (${lang}) is listed in translations.json but does not exist`);
        continue;
      }
      const targets = linkTargets(abs, readFileSync(abs, "utf8"));
      for (const [otherLang, otherRel] of entries) {
        if (otherRel === rel || !existsSync(resolve(root, otherRel))) continue;
        if (!targets.has(resolve(root, otherRel))) errors.push(`${rel} does not link to its ${otherLang} version ${otherRel}`);
      }
    }
  }
  const single = new Set((map.singleLanguage || []).map(toPosix));
  for (const dirRel of map.warnUnpairedIn || []) {
    const dir = resolve(root, dirRel);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const rel = toPosix(relative(root, file));
      if (rel.endsWith(".md") && !listed.has(rel) && !single.has(rel) && !/\/README\.md$/.test(rel)) {
        warnings.push(`${rel} has no translation (add it to translations.json pairs or singleLanguage)`);
      }
    }
  }
  return { errors, warnings, pairs: pairs.length };
}

function main() {
  const root = rootArg(join(__dirname, "../.."));
  const files = walk(root);
  const broken = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    let m;
    while ((m = LINK_RE.exec(content)) !== null) {
      const target = m[2].split("#")[0];
      if (!target || target === "url" || target.includes("abc1234") || SKIP.some((p) => target.startsWith(p))) continue;
      const resolved = resolve(dirname(file), target);
      try {
        statSync(resolved);
      } catch {
        broken.push({ file: toPosix(relative(root, file)), link: m[2] });
      }
    }
  }

  if (broken.length) {
    console.error(`Broken links: ${broken.length}`);
    for (const b of broken.slice(0, 40)) console.error(`  ${b.file} → ${b.link}`);
    ciErrorList(
      "Broken doc link",
      broken.map((b) => ({ file: b.file, message: `Link target not found: ${b.link}` })),
      `${broken.length} Markdown link(s) point to files that do not exist. Fix or remove them (paths are relative to the file that contains the link). Reproduce: npm run docs:check`
    );
    process.exit(1);
  }

  const translations = checkTranslations(root);
  for (const w of translations.warnings) console.warn(`warn: ${w}`);
  if (translations.errors.length) {
    console.error(`Translation pairs: ${translations.errors.length} problem(s)`);
    for (const e of translations.errors) console.error(`  ${e}`);
    ciErrorList(
      "Translated doc pair",
      translations.errors,
      `Every pair in ${TRANSLATIONS_MAP} must exist on both sides and link to each other. Fix the pairs above. Reproduce: npm run docs:check`
    );
    process.exit(1);
  }

  console.log(`docs:check OK — ${files.length} files, ${translations.pairs} translated pair(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
