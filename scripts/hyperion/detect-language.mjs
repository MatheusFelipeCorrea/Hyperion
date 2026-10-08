#!/usr/bin/env node
/**
 * Suggest the team language from repo text (README, recent commit subjects, recent PR titles).
 * Only a suggestion for /setup — the person always confirms.
 *
 * CLI: node detect-language.mjs [--json] [--no-gh]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const STOPWORDS = {
  en: ["the", "and", "is", "are", "to", "of", "for", "with", "this", "that", "from", "you", "not", "how", "when", "use", "add", "fix", "update", "remove"],
  "pt-BR": ["de", "da", "do", "das", "dos", "para", "com", "não", "uma", "um", "é", "são", "como", "quando", "você", "adiciona", "corrige", "atualiza", "remove", "ajusta", "também", "está", "pelo", "pela"],
  es: ["de", "la", "el", "los", "las", "para", "con", "no", "una", "un", "es", "son", "como", "cuando", "usted", "añade", "corrige", "actualiza", "elimina", "también", "está", "por", "del"],
  fr: ["le", "la", "les", "des", "pour", "avec", "est", "sont", "une", "un", "pas", "comme", "quand", "vous", "ajoute", "corrige", "mise", "supprime", "aussi", "dans", "du"],
  de: ["der", "die", "das", "und", "ist", "sind", "für", "mit", "nicht", "eine", "ein", "wie", "wenn", "sie", "hinzufügen", "behebt", "aktualisiert", "entfernt", "auch", "auf", "dem"],
};

/** Words distinctive enough to break pt/es ties (and keep en from winning on code noise). */
const DISTINCT = {
  "pt-BR": ["não", "você", "também", "são", "ção", "ções", "ão", "lh", "nh"],
  es: ["ñ", "¿", "¡", "ción", "ciones", "usted", "también"],
  fr: ["ç", "è", "ê", "œ"],
  de: ["ß", "ü", "ö", "ä"],
};

function words(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^(feat|fix|chore|docs|refactor|test|ci|build|perf|style|revert)(\([^)]*\))?!?:/gm, " ")
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length > 1);
}

/**
 * Score text per language.
 * @returns {{ language: string|null, confidence: number, scores: Record<string, number> }}
 */
export function scoreLanguage(text) {
  const list = words(text);
  const scores = {};
  for (const [lang, stop] of Object.entries(STOPWORDS)) {
    const set = new Set(stop);
    scores[lang] = list.filter((w) => set.has(w)).length;
  }
  const lower = String(text || "").toLowerCase();
  for (const [lang, marks] of Object.entries(DISTINCT)) {
    scores[lang] += marks.reduce((acc, m) => acc + Math.min(lower.split(m).length - 1, 20), 0);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top || top[1] < 3) return { language: null, confidence: 0, scores };
  const confidence = Number((top[1] / (top[1] + (second?.[1] || 0))).toFixed(2));
  return { language: top[0], confidence, scores };
}

function readmeText(root) {
  for (const name of ["README.md", "readme.md", "README.MD", "README", "docs/README.md"]) {
    try {
      return fs.readFileSync(path.join(root, name), "utf8").slice(0, 20000);
    } catch {
      /* next */
    }
  }
  return "";
}

function gitSubjects(root, n = 30) {
  try {
    return execFileSync("git", ["log", `-${n}`, "--format=%s"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
}

function prTitles(root, n = 20) {
  try {
    return execFileSync("gh", ["pr", "list", "--state", "all", "--limit", String(n), "--json", "title", "--jq", ".[].title"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    }).toString();
  } catch {
    return "";
  }
}

/**
 * @returns {{ suggestion: string, confidence: number, sources: Record<string, {language: string|null, confidence: number}>, alsoSeen: string[] }}
 */
export function detectRepoLanguage(root = process.cwd(), { gh = true } = {}) {
  const texts = { readme: readmeText(root), commits: gitSubjects(root), prs: gh ? prTitles(root) : "" };
  const sources = {};
  const total = {};
  const weight = { readme: 1, commits: 2, prs: 2 };
  for (const [name, text] of Object.entries(texts)) {
    if (!text.trim()) continue;
    const r = scoreLanguage(text);
    sources[name] = { language: r.language, confidence: r.confidence };
    if (r.language) total[r.language] = (total[r.language] || 0) + weight[name] * r.confidence;
  }
  const ranked = Object.entries(total).sort((a, b) => b[1] - a[1]);
  const sum = ranked.reduce((acc, [, v]) => acc + v, 0) || 1;
  return {
    suggestion: ranked[0]?.[0] || "en",
    confidence: ranked.length ? Number((ranked[0][1] / sum).toFixed(2)) : 0,
    sources,
    alsoSeen: ranked.slice(1).map(([l]) => l),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = detectRepoLanguage(process.cwd(), { gh: !process.argv.includes("--no-gh") });
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Suggested language: ${result.suggestion} (confidence ${result.confidence})`);
    for (const [name, r] of Object.entries(result.sources)) console.log(`  ${name.padEnd(8)} ${r.language || "?"} (${r.confidence})`);
    if (result.alsoSeen.length) console.log(`  also seen: ${result.alsoSeen.join(", ")} — consider languages: [${[result.suggestion, ...result.alsoSeen].join(", ")}]`);
  }
}
