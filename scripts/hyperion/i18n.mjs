/**
 * Language resolution + message catalogs for fixed script strings (CI, CLI, board guard, reconcile).
 *
 * No dependencies: product CI runs kit scripts (coverage-gate, diff-coverage) without npm install.
 *
 * project.yml:
 *   locale: pt-BR              # primary language (any BCP 47 tag)
 *   languages: [pt-BR, en]     # optional; primary first; >1 = multilingual
 *   i18n: { multilingual: [pr, comments, release] }
 *
 * Catalogs: scripts/hyperion/i18n/<tag>.json (shipped: en, pt-BR, es) merged with the
 * repo override .github/i18n/<tag>.json. Missing keys fall back tag → base → same-base shipped → en.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "i18n");
export const SHIPPED_LANGUAGES = ["en", "pt-BR", "es"];
export const DEFAULT_MULTILINGUAL = ["pr", "comments", "release"];
export const MULTILINGUAL_SURFACES = ["pr", "comments", "release", "docs", "issues"];
const TAG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** "pt_br" → "pt-BR", "EN" → "en", "zh-hant-tw" → "zh-Hant-TW". */
export function normalizeTag(tag) {
  const raw = String(tag ?? "").trim().replace(/_/g, "-").replace(/^["']|["']$/g, "");
  if (!TAG_RE.test(raw)) return null;
  return raw
    .split("-")
    .map((part, i) => {
      if (i === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
      return part.toLowerCase();
    })
    .join("-");
}

export const baseLanguage = (tag) => String(normalizeTag(tag) || "en").split("-")[0];

/** Lookup order for one tag (deduplicated): exact, base, shipped with the same base, en. */
export function fallbackChain(tag) {
  const t = normalizeTag(tag) || "en";
  const base = t.split("-")[0];
  const sameBase = SHIPPED_LANGUAGES.filter((s) => s.split("-")[0] === base);
  return [...new Set([t, base, ...sameBase, "en"])];
}

/** Human name of a language in that language ("English", "Português (Brasil)", "Español"). */
export function languageName(tag) {
  const t = normalizeTag(tag) || "en";
  try {
    const name = new Intl.DisplayNames([t], { type: "language" }).of(t) || t;
    return name.charAt(0).toLocaleUpperCase(t) + name.slice(1);
  } catch {
    return t;
  }
}

function listValue(raw) {
  const v = raw.trim();
  if (v.startsWith("[")) {
    return v
      .replace(/^\[|\].*$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return null;
}

function blockList(lines, start, indent) {
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s*(.+?)\s*(#.*)?$/);
    if (m && m[1].length > indent) out.push(m[2].replace(/^["']|["']$/g, ""));
    else if (lines[i].trim() && !lines[i].trim().startsWith("#")) break;
  }
  return out;
}

/**
 * Parse locale / languages / i18n.multilingual without a YAML library.
 * @returns {{ locale: string|null, languages: string[]|null, multilingual: string[]|null }}
 */
export function parseLanguageConfig(text) {
  const lines = String(text || "").split(/\r?\n/);
  let locale = null;
  let languages = null;
  let multilingual = null;
  let inI18n = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) inI18n = /^i18n\s*:\s*(#.*)?$/.test(line);
    let m = line.match(/^locale\s*:\s*([^\s#]+)/);
    if (m) locale = normalizeTag(m[1]);
    m = line.match(/^languages\s*:\s*(.*)$/);
    if (m) languages = (listValue(m[1]) ?? blockList(lines, i + 1, 0)).map(normalizeTag).filter(Boolean);
    m = inI18n && line.match(/^(\s+)multilingual\s*:\s*(.*)$/);
    if (m) multilingual = listValue(m[2]) ?? blockList(lines, i + 1, m[1].length);
  }
  return { locale, languages: languages?.length ? languages : null, multilingual };
}

/**
 * @typedef {{ primary: string, languages: string[], multilingual: string[], source: string }} LanguageSettings
 */

/** Settings from project.yml text (falls back to a locale hint, then en). */
export function languageSettingsFrom(projectText, { fallbackLocale = null } = {}) {
  const cfg = parseLanguageConfig(projectText);
  const primary = cfg.locale || cfg.languages?.[0] || normalizeTag(fallbackLocale) || "en";
  const languages = [primary, ...(cfg.languages || []).filter((l) => l !== primary)];
  const multilingual = (cfg.multilingual || DEFAULT_MULTILINGUAL).filter((s) => MULTILINGUAL_SURFACES.includes(s));
  const source = cfg.locale || cfg.languages ? "project.yml" : fallbackLocale ? "projects-map" : "default";
  return { primary, languages, multilingual, source };
}

/**
 * Resolve from a repo root: .github/project.yml (or the nested kit copy), then
 * projects-map.json default.locale, then en.
 * @returns {LanguageSettings & { projectYmlPath: string|null }}
 */
export function resolveLanguages(root = process.cwd()) {
  const candidates = [path.join(root, ".github", "project.yml")];
  const kitRoot = (() => {
    try {
      return fs.readFileSync(candidates[0], "utf8").match(/^kit:\s*\n\s+root:\s*["']?([^\s#"']+)/m)?.[1] || null;
    } catch {
      return fs.existsSync(path.join(root, "Hyperion", ".github")) ? "Hyperion" : null;
    }
  })();
  if (kitRoot) candidates.push(path.join(root, kitRoot, ".github", "project.yml"));
  let projectText = "";
  let projectYmlPath = null;
  for (const c of candidates) {
    try {
      projectText = fs.readFileSync(c, "utf8");
      projectYmlPath = c;
      break;
    } catch {
      /* next */
    }
  }
  let fallbackLocale = null;
  for (const dir of [path.join(root, ".github"), kitRoot && path.join(root, kitRoot, ".github")].filter(Boolean)) {
    try {
      const map = JSON.parse(fs.readFileSync(path.join(dir, "cards", "config", "projects-map.json"), "utf8"));
      fallbackLocale = map?.default?.locale || map?.locale || null;
      if (fallbackLocale) break;
    } catch {
      /* none */
    }
  }
  return { ...languageSettingsFrom(projectText, { fallbackLocale }), projectYmlPath };
}

/** Problems with locale/languages (for project-verify and doctor). */
export function validateLanguageConfig(projectText) {
  const cfg = parseLanguageConfig(projectText);
  const errors = [];
  const warnings = [];
  if (!cfg.locale) warnings.push("locale is not set — Hyperion falls back to en; run /setup to pick the team language(s)");
  if (cfg.languages && cfg.locale && cfg.languages[0] !== cfg.locale) {
    errors.push(`languages[0] (${cfg.languages[0]}) must equal locale (${cfg.locale})`);
  }
  for (const s of cfg.multilingual || []) {
    if (!MULTILINGUAL_SURFACES.includes(s)) errors.push(`i18n.multilingual: unknown surface "${s}" (${MULTILINGUAL_SURFACES.join(", ")})`);
  }
  return { errors, warnings, config: cfg };
}

/**
 * Write locale (+ languages when more than one) into project.yml text, preserving the rest.
 * @param {string} text
 * @param {{ locale?: string|null, languages?: string[]|null }} opts
 */
export function applyLanguageConfig(text, { locale = null, languages = null } = {}) {
  const list = (languages || []).map(normalizeTag).filter(Boolean);
  const primary = normalizeTag(locale) || list[0];
  if (!primary) throw new Error("applyLanguageConfig: locale or languages required");
  const all = [primary, ...list.filter((l) => l !== primary)];
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let replacedLocale = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^locale\s*:/.test(line)) {
      out.push(`locale: ${primary}`);
      replacedLocale = true;
      continue;
    }
    if (/^languages\s*:/.test(line)) {
      if (!listValue(line.replace(/^languages\s*:/, ""))) {
        while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
      }
      continue;
    }
    out.push(line);
  }
  if (!replacedLocale) {
    const at = out.findIndex((l) => /^version\s*:/.test(l));
    out.splice(at >= 0 ? at + 1 : 0, 0, `locale: ${primary}`);
  }
  if (all.length > 1) {
    const at = out.findIndex((l) => /^locale\s*:/.test(l));
    out.splice(at + 1, 0, `languages: [${all.join(", ")}]`);
  }
  return out.join("\n");
}

const cache = new Map();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Raw catalog for one tag (shipped + repo override), without fallback. */
export function loadCatalog(tag, { root = null } = {}) {
  const key = `${tag}|${root || ""}`;
  if (cache.has(key)) return cache.get(key);
  const shipped = readJson(path.join(CATALOG_DIR, `${tag}.json`)) || {};
  const override = root ? readJson(path.join(root, ".github", "i18n", `${tag}.json`)) || {} : {};
  const merged = { ...shipped, ...override };
  cache.set(key, merged);
  return merged;
}

export function clearCatalogCache() {
  cache.clear();
}

function interpolate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

/** Message for key in lang (fallback chain); returns the key itself when missing everywhere. */
export function t(key, vars = {}, lang = "en", { root = null } = {}) {
  for (const tag of fallbackChain(lang)) {
    const v = loadCatalog(tag, { root })[key];
    if (typeof v === "string") return interpolate(v, vars);
  }
  return key;
}

/**
 * Text safe inside a double-quoted shell string: the template is escaped, then the
 * placeholders get raw shell fragments (e.g. { branch: "$PR_BRANCH" }).
 */
export function tShell(key, shellVars = {}, lang = "en", opts = {}) {
  const template = t(key, Object.fromEntries(Object.keys(shellVars).map((k) => [k, `\u0000${k}\u0000`])), lang, opts);
  const safe = template.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/\n/g, " ");
  return safe.replace(/\u0000(\w+)\u0000/g, (_, k) => shellVars[k]);
}

/**
 * Primary text, then one collapsed <details> per extra language.
 * @param {(lang: string) => string} render
 */
export function multiRender(render, languages) {
  const [primary, ...extra] = languages?.length ? languages : ["en"];
  const parts = [render(primary).trimEnd()];
  for (const lang of extra) {
    parts.push("", `<details><summary>${languageName(lang)}</summary>`, "", render(lang).trimEnd(), "", "</details>");
  }
  return `${parts.join("\n")}\n`;
}

/** Languages to render for a surface: all when multilingual is on for it, else only the primary. */
export function languagesFor(settings, surface) {
  if (!settings) return ["en"];
  return settings.languages.length > 1 && settings.multilingual.includes(surface) ? settings.languages : [settings.primary];
}

/** Bound helpers for one repo/settings. */
export function translator(settings, { root = null } = {}) {
  const s = settings || { primary: "en", languages: ["en"], multilingual: DEFAULT_MULTILINGUAL };
  return {
    settings: s,
    lang: s.primary,
    t: (key, vars) => t(key, vars, s.primary, { root }),
    tIn: (lang, key, vars) => t(key, vars, lang, { root }),
    shell: (key, shellVars) => tShell(key, shellVars, s.primary, { root }),
    multi: (surface, render) => multiRender(render, languagesFor(s, surface)),
  };
}

/** Every translation of key across shipped catalogs + the repo override languages (for parsing). */
export function keyVariants(key, { root = null, extra = [] } = {}) {
  let overrides = [];
  try {
    overrides = root ? fs.readdirSync(path.join(root, ".github", "i18n")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  } catch {
    /* none */
  }
  const tags = [...new Set([...SHIPPED_LANGUAGES, ...overrides, ...extra])];
  return [...new Set(tags.map((tag) => t(key, {}, tag, { root })))];
}

/** Keys present in en but missing (after fallback to the same base) for tag. */
export function missingKeys(tag, { root = null } = {}) {
  const en = loadCatalog("en", { root });
  const chain = fallbackChain(tag).filter((l) => l !== "en");
  return Object.keys(en).filter((k) => !chain.some((l) => typeof loadCatalog(l, { root })[k] === "string"));
}

/** True when fixed strings for tag come from a real catalog (shipped or repo override). */
export function hasCatalog(tag, { root = null } = {}) {
  return fallbackChain(tag)
    .filter((l) => l !== "en")
    .some((l) => Object.keys(loadCatalog(l, { root })).length > 0) || baseLanguage(tag) === "en";
}
