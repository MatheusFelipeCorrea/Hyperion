#!/usr/bin/env node
/**
 * Coverage gate — dependency-free, runs inside product CI.
 *
 * Reads the first coverage report found (or --file) in any of:
 *   istanbul json-summary · lcov · cobertura xml · jacoco xml · go coverprofile · simplecov .last_run.json
 * prints every metric, writes the GitHub Job Summary and enforces --min on --metric.
 *
 * Usage:
 *   node coverage-gate.mjs --dir . --metric lines --min 80 [--mode block|warn]
 *                          [--file coverage/lcov.info] [--ignore "lib/generated/**,*.g.dart"] [--label api]
 *                          [--summary-out file.md] [--diff-base <sha> --diff-min 80 [--diff-mode warn|block]]
 *                          [--lang pt-BR,en]   (primary first; extras as <details> in the summary)
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { multiRender, normalizeTag, t } from "./i18n.mjs";
import { makeIgnore } from "./coverage-ignore.mjs";
import { diffCoverageFromGit, renderDiffSummary } from "./diff-coverage.mjs";

export { globToRegExp, makeIgnore } from "./coverage-ignore.mjs";

export const METRICS = ["lines", "statements", "branches", "functions"];

const CANDIDATES = [
  "coverage/coverage-summary.json",
  "coverage-summary.json",
  "coverage/lcov.info",
  "lcov.info",
  "coverage.xml",
  "coverage/cobertura-coverage.xml",
  "cobertura.xml",
  "target/site/jacoco/jacoco.xml",
  "build/reports/jacoco/test/jacocoTestReport.xml",
  "build/reports/kover/report.xml",
  "coverage.out",
  "cover.out",
  "coverage/.last_run.json",
];

const RECURSIVE_NAMES = ["coverage.cobertura.xml", "jacocoTestReport.xml", "lcov.info", "coverage-summary.json"];
const SKIP = new Set(["node_modules", ".git", ".dart_tool", "vendor", ".venv"]);

function emptyTotals() {
  return Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }]));
}

function pct(c) {
  if (!c) return null;
  if (typeof c.pct === "number") return c.pct;
  return c.total > 0 ? (c.covered / c.total) * 100 : null;
}

export function parseIstanbulSummary(text, ignored = () => false) {
  const json = JSON.parse(text);
  const files = Object.entries(json).filter(([k]) => k !== "total");
  const anyIgnored = files.some(([k]) => ignored(k));
  if (!anyIgnored && json.total) {
    const out = {};
    for (const m of METRICS) {
      const t = json.total[m];
      if (t) out[m] = { total: t.total, covered: t.covered };
    }
    return { format: "istanbul-json-summary", totals: out, files: files.length };
  }
  const totals = emptyTotals();
  let kept = 0;
  for (const [file, data] of files) {
    if (ignored(file)) continue;
    kept += 1;
    for (const m of METRICS) {
      if (data[m]) {
        totals[m].total += data[m].total;
        totals[m].covered += data[m].covered;
      }
    }
  }
  return { format: "istanbul-json-summary", totals, files: kept };
}

export function parseLcov(text, ignored = () => false) {
  const totals = emptyTotals();
  let file = null;
  let skip = false;
  let kept = 0;
  let lineHits = null;
  const flush = () => {
    if (file && !skip && lineHits) {
      totals.lines.total += lineHits.size;
      totals.lines.covered += [...lineHits.values()].filter((h) => h > 0).length;
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = line.slice(3);
      skip = ignored(file);
      if (!skip) kept += 1;
      lineHits = new Map();
    } else if (line === "end_of_record") {
      flush();
      file = null;
      lineHits = null;
    } else if (!skip && lineHits) {
      const [tag, rest] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)];
      if (tag === "DA") {
        const [ln, hits] = rest.split(",");
        lineHits.set(ln, Math.max(lineHits.get(ln) || 0, Number(hits) || 0));
      } else if (tag === "BRF") totals.branches.total += Number(rest) || 0;
      else if (tag === "BRH") totals.branches.covered += Number(rest) || 0;
      else if (tag === "FNF") totals.functions.total += Number(rest) || 0;
      else if (tag === "FNH") totals.functions.covered += Number(rest) || 0;
    }
  }
  totals.statements = { ...totals.lines };
  return { format: "lcov", totals, files: kept };
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

export function parseCobertura(text, ignored = () => false) {
  const totals = emptyTotals();
  const seen = new Map();
  let kept = 0;
  const classRe = /<class\b([^>]*)>([\s\S]*?)<\/class>/g;
  let m;
  while ((m = classRe.exec(text))) {
    const file = attr(` ${m[1]}`, "filename") || "";
    if (ignored(file)) continue;
    kept += 1;
    const body = m[2];
    const methodsBlock = body.match(/<methods>([\s\S]*?)<\/methods>/);
    if (methodsBlock) {
      const methodRe = /<method\b([^>]*)>/g;
      let mm;
      while ((mm = methodRe.exec(methodsBlock[1]))) {
        totals.functions.total += 1;
        if (Number(attr(` ${mm[1]}`, "line-rate")) > 0) totals.functions.covered += 1;
      }
    }
    const linesBody = body.replace(/<methods>[\s\S]*?<\/methods>/, "");
    const lineRe = /<line\b([^>]*?)\/?>/g;
    let lm;
    while ((lm = lineRe.exec(linesBody))) {
      const a = ` ${lm[1]}`;
      const key = `${file}:${attr(a, "number")}`;
      const hits = Number(attr(a, "hits")) || 0;
      const prev = seen.get(key);
      const cc = attr(a, "condition-coverage");
      const br = cc ? cc.match(/\((\d+)\/(\d+)\)/) : null;
      const entry = prev || { hits: 0, brCovered: 0, brTotal: 0 };
      entry.hits = Math.max(entry.hits, hits);
      if (br) {
        entry.brCovered = Math.max(entry.brCovered, Number(br[1]));
        entry.brTotal = Math.max(entry.brTotal, Number(br[2]));
      }
      seen.set(key, entry);
    }
  }
  for (const e of seen.values()) {
    totals.lines.total += 1;
    if (e.hits > 0) totals.lines.covered += 1;
    totals.branches.total += e.brTotal;
    totals.branches.covered += e.brCovered;
  }
  totals.statements = { ...totals.lines };
  if (totals.functions.total === 0) delete totals.functions;
  return { format: "cobertura", totals, files: kept };
}

const JACOCO_TYPES = { lines: "LINE", branches: "BRANCH", functions: "METHOD", statements: "INSTRUCTION" };

export function parseJacoco(text, ignored = () => false) {
  const totals = emptyTotals();
  let kept = 0;
  const pkgRe = /<package\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g;
  let pm;
  let sawSourcefile = false;
  while ((pm = pkgRe.exec(text))) {
    const pkg = pm[1];
    const srcRe = /<sourcefile\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/sourcefile>/g;
    let sm;
    while ((sm = srcRe.exec(pm[2]))) {
      sawSourcefile = true;
      const file = pkg ? `${pkg}/${sm[1]}` : sm[1];
      if (ignored(file)) continue;
      kept += 1;
      for (const [metric, type] of Object.entries(JACOCO_TYPES)) {
        const c = sm[2].match(new RegExp(`<counter\\b[^>]*type="${type}"[^>]*/>`));
        if (!c) continue;
        totals[metric].total += (Number(attr(` ${c[0]}`, "missed")) || 0) + (Number(attr(` ${c[0]}`, "covered")) || 0);
        totals[metric].covered += Number(attr(` ${c[0]}`, "covered")) || 0;
      }
    }
  }
  if (!sawSourcefile) {
    const tail = text.replace(/<package\b[\s\S]*<\/package>/g, "");
    for (const [metric, type] of Object.entries(JACOCO_TYPES)) {
      const c = tail.match(new RegExp(`<counter\\b[^>]*type="${type}"[^>]*/>`));
      if (!c) continue;
      totals[metric].total = (Number(attr(` ${c[0]}`, "missed")) || 0) + (Number(attr(` ${c[0]}`, "covered")) || 0);
      totals[metric].covered = Number(attr(` ${c[0]}`, "covered")) || 0;
    }
  }
  return { format: "jacoco", totals, files: kept };
}

export function parseGoCover(text, ignored = () => false) {
  const blocks = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("mode:")) continue;
    const m = line.match(/^(.+?):(\d+\.\d+,\d+\.\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    if (ignored(m[1])) continue;
    const key = `${m[1]}:${m[2]}`;
    const prev = blocks.get(key);
    const stmts = Number(m[3]);
    const count = Number(m[4]);
    blocks.set(key, { stmts, hit: (prev?.hit || false) || count > 0 });
  }
  const s = { total: 0, covered: 0 };
  for (const b of blocks.values()) {
    s.total += b.stmts;
    if (b.hit) s.covered += b.stmts;
  }
  const files = new Set([...blocks.keys()].map((k) => k.slice(0, k.lastIndexOf(":")))).size;
  return { format: "go-coverprofile", totals: { statements: s, lines: { ...s } }, files };
}

export function parseSimplecov(text) {
  const json = JSON.parse(text);
  const r = json.result || {};
  const totals = {};
  const line = r.line ?? r.covered_percent;
  if (typeof line === "number") totals.lines = { pct: line };
  if (typeof r.branch === "number") totals.branches = { pct: r.branch };
  return { format: "simplecov", totals, files: null };
}

export function detectFormat(file, text) {
  const base = path.basename(file);
  if (base === ".last_run.json") return "simplecov";
  if (base.endsWith(".json")) return "istanbul-json-summary";
  if (base.endsWith(".info") || /^(TN:|SF:)/m.test(text.slice(0, 2000))) return "lcov";
  if (/^mode:\s*(set|count|atomic)/m.test(text.slice(0, 200))) return "go-coverprofile";
  if (/<report\b/.test(text.slice(0, 4000)) || /jacoco/i.test(text.slice(0, 400))) return "jacoco";
  if (/<coverage\b/.test(text.slice(0, 4000))) return "cobertura";
  return null;
}

export function parseReport(file, text, ignorePatterns = []) {
  const ignored = makeIgnore(ignorePatterns);
  const fmt = detectFormat(file, text);
  switch (fmt) {
    case "istanbul-json-summary":
      return parseIstanbulSummary(text, ignored);
    case "lcov":
      return parseLcov(text, ignored);
    case "cobertura":
      return parseCobertura(text, ignored);
    case "jacoco":
      return parseJacoco(text, ignored);
    case "go-coverprofile":
      return parseGoCover(text, ignored);
    case "simplecov":
      return parseSimplecov(text);
    default:
      throw new Error(`Unrecognized coverage report format: ${file}`);
  }
}

function findRecursive(dir, depth = 0) {
  if (depth > 5) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && RECURSIVE_NAMES.includes(e.name)) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP.has(e.name)) {
      const hit = findRecursive(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function findReport(dir, explicit = null) {
  if (explicit) {
    const abs = path.resolve(dir, explicit);
    if (fs.existsSync(abs)) return abs;
    if (/[*]/.test(explicit)) {
      const base = path.basename(explicit);
      return findRecursiveNamed(path.resolve(dir, explicit.split("*")[0] || "."), base);
    }
    return null;
  }
  for (const c of CANDIDATES) {
    const abs = path.join(dir, c);
    if (fs.existsSync(abs)) return abs;
  }
  return findRecursive(dir);
}

function findRecursiveNamed(dir, name, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name);
  for (const e of entries) {
    if (e.isDirectory() && !SKIP.has(e.name)) {
      const hit = findRecursiveNamed(path.join(dir, e.name), name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * @returns {{ ok: boolean, status: "pass"|"fail"|"missing", metric: string, value: number|null, min: number, report: object|null, file: string|null, note?: string }}
 */
export function evaluateCoverage({ dir = process.cwd(), file = null, metric = "lines", min = 0, ignore = [] } = {}) {
  const found = findReport(dir, file);
  if (!found) return { ok: false, status: "missing", metric, value: null, min, report: null, file: null };
  const report = parseReport(found, fs.readFileSync(found, "utf8"), ignore);
  let used = metric;
  let note;
  if (pct(report.totals[metric]) === null) {
    used = pct(report.totals.lines) !== null ? "lines" : pct(report.totals.statements) !== null ? "statements" : metric;
    note = `metric "${metric}" not available in ${report.format}; using "${used}"`;
  }
  const value = pct(report.totals[used]);
  const ok = value !== null && value + 1e-9 >= min;
  const noteVars = note ? { metric, format: report.format, used } : null;
  return { ok, status: ok ? "pass" : "fail", metric: used, value, min, report, file: found, ...(note ? { note, noteVars } : {}) };
}

const catalogRoot = () => process.env.GITHUB_WORKSPACE || null;
const msg = (key, vars, lang) => t(key, vars, lang, { root: catalogRoot() });

function fmtPct(v) {
  return v === null || v === undefined ? "—" : `${v.toFixed(2)}%`;
}

export function renderSummary(result, { label = "", mode = "block", lang = "en" } = {}) {
  const head = `### ${msg("coverage.heading", {}, lang)}${label ? ` — ${label}` : ""}`;
  if (result.status === "missing") {
    return `${head}\n\n❌ ${msg("coverage.missing", { mode }, lang)}\n`;
  }
  const rows = METRICS.filter((m) => result.report.totals[m]).map((m) => {
    const c = result.report.totals[m];
    const counts = typeof c.total === "number" ? `${c.covered}/${c.total}` : "";
    const mark = m === result.metric ? " ◀" : "";
    return `| ${m}${mark} | ${fmtPct(pct(c))} | ${counts} |`;
  });
  const icon = result.ok ? "✅" : mode === "warn" ? "⚠️" : "❌";
  return [
    head,
    "",
    `${icon} ${msg("coverage.result", { metric: result.metric, value: fmtPct(result.value), min: result.min, mode, format: result.report.format, file: path.basename(result.file) }, lang)}`,
    "",
    msg("coverage.tableHeader", {}, lang),
    "|---|---|---|",
    ...rows,
    result.note ? `\n_${result.noteVars ? msg("coverage.metricFallback", result.noteVars, lang) : result.note}_` : "",
    "",
  ].join("\n");
}

export function parseArgs(argv) {
  const out = {
    dir: ".",
    metric: "lines",
    min: 0,
    mode: "block",
    file: null,
    ignore: [],
    label: "",
    summaryOut: null,
    diffBase: null,
    diffMin: null,
    diffMode: null,
    diffFile: null,
    langs: ["en"],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--dir") out.dir = next();
    else if (a === "--metric") out.metric = next();
    else if (a === "--min") out.min = Number(next());
    else if (a === "--mode") out.mode = next();
    else if (a === "--file") out.file = next();
    else if (a === "--ignore") out.ignore.push(next());
    else if (a === "--label") out.label = next();
    else if (a === "--summary-out") out.summaryOut = next();
    else if (a === "--diff-base") out.diffBase = next() || null;
    else if (a === "--diff-min") out.diffMin = Number(next());
    else if (a === "--diff-mode") out.diffMode = next();
    else if (a === "--diff-file") out.diffFile = next();
    else if (a === "--lang") out.langs = String(next() || "").split(",").map(normalizeTag).filter(Boolean);
  }
  if (!out.langs.length) out.langs = ["en"];
  if (!METRICS.includes(out.metric)) out.metric = "lines";
  if (!Number.isFinite(out.min)) out.min = 0;
  if (out.mode !== "warn") out.mode = "block";
  if (!Number.isFinite(out.diffMin)) out.diffMin = null;
  out.diffMode = out.diffMode === "warn" ? "warn" : out.diffMode === "block" ? "block" : out.mode;
  out.ignore = out.ignore.flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);
  const level = (mode) => (mode === "warn" ? "warning" : "error");
  const lang = args.langs[0];
  const gateTitle = msg("coverage.gateTitle", {}, lang);
  const title = `${gateTitle}${args.label ? ` (${args.label})` : ""}`;
  let failed = false;
  let result;
  try {
    result = evaluateCoverage({ dir, file: args.file, metric: args.metric, min: args.min, ignore: args.ignore });
  } catch (e) {
    console.error(`::error title=${gateTitle}::${e.message}`);
    process.exit(args.mode === "warn" ? 0 : 1);
  }
  const sections = [(l) => renderSummary(result, { ...args, lang: l })];

  if (args.diffBase && args.diffMin !== null && !/^0+$/.test(args.diffBase)) {
    try {
      const diff = diffCoverageFromGit({ dir, base: args.diffBase, file: args.diffFile, min: args.diffMin, ignore: args.ignore });
      if (diff.missing) {
        sections.push((l) => `\n#### ${msg("coverage.diff.heading", {}, l)}\n\n${msg("coverage.diff.noReport", {}, l)}\n`);
        console.log(`::warning title=${title}::${msg("coverage.annot.diffNeedsLines", {}, lang)}`);
      } else {
        sections.push((l) => `\n${renderDiffSummary(diff, { mode: args.diffMode, lang: l, root: catalogRoot() })}`);
        if (!diff.ok) {
          console.log(`::${level(args.diffMode)} title=${title}::${msg("coverage.annot.diffBelow", { pct: diff.pct.toFixed(2), min: args.diffMin }, lang)}`);
          if (args.diffMode === "block") failed = true;
        }
      }
    } catch (e) {
      console.log(`::warning title=${title}::${msg("coverage.annot.diffSkipped", { reason: e.message.split("\n")[0] }, lang)}`);
    }
  }

  const summary = args.langs.length > 1
    ? multiRender((l) => sections.map((s) => s(l)).join(""), args.langs)
    : sections.map((s) => s(lang)).join("");
  console.log(summary);
  for (const target of [process.env.GITHUB_STEP_SUMMARY, args.summaryOut]) {
    if (!target) continue;
    try {
      fs.appendFileSync(target, `${summary}\n`);
    } catch {
      /* summary is best-effort */
    }
  }
  if (result.status === "missing") {
    console.log(`::${level(args.mode)} title=${title}::${msg("coverage.annot.missing", { dir: args.dir }, lang)}`);
    if (args.mode === "block") failed = true;
  } else if (!result.ok) {
    console.log(`::${level(args.mode)} title=${title}::${msg("coverage.annot.below", { metric: result.metric, value: fmtPct(result.value), min: result.min }, lang)}`);
    if (args.mode === "block") failed = true;
  }
  process.exit(failed ? 1 : 0);
}
