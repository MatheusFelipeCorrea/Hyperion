/**
 * Coverage of the lines a change adds (diff / patch coverage).
 *
 * Inputs: `git diff -U0 <base>...HEAD` output and a line-level coverage report
 * (lcov, Cobertura, Go cover profile or Istanbul coverage-final.json). Paths are
 * matched by suffix, so reports with absolute or app-relative paths both work.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeIgnore } from "./coverage-gate.mjs";

const toPosix = (p) => String(p || "").replace(/\\/g, "/");

/** @returns {Map<string, Set<number>>} file → added line numbers (new side) */
export function parseAddedLines(diffText) {
  const out = new Map();
  let file = null;
  let line = 0;
  for (const raw of String(diffText || "").split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : toPosix(p.replace(/^b\//, ""));
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      out.get(file).add(line);
      line += 1;
    } else if (raw.startsWith(" ")) {
      line += 1;
    }
  }
  for (const [f, set] of out) if (!set.size) out.delete(f);
  return out;
}

function addHit(map, file, ln, hits) {
  const key = toPosix(file);
  if (!map.has(key)) map.set(key, new Map());
  const lines = map.get(key);
  lines.set(ln, Math.max(lines.get(ln) || 0, hits));
}

/** @returns {Map<string, Map<number, number>>} file → line → hits */
export function lineHitsFromLcov(text) {
  const map = new Map();
  let file = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith("SF:")) file = l.slice(3);
    else if (l === "end_of_record") file = null;
    else if (file && l.startsWith("DA:")) {
      const [ln, hits] = l.slice(3).split(",");
      addHit(map, file, Number(ln), Number(hits) || 0);
    }
  }
  return map;
}

export function lineHitsFromCobertura(text) {
  const map = new Map();
  const sources = [...String(text).matchAll(/<source>([^<]*)<\/source>/g)].map((m) => toPosix(m[1].trim()));
  const classRe = /<class\b([^>]*)>([\s\S]*?)<\/class>/g;
  let m;
  while ((m = classRe.exec(text))) {
    const fname = (m[1].match(/\sfilename="([^"]*)"/) || [])[1];
    if (!fname) continue;
    const body = m[2].replace(/<methods>[\s\S]*?<\/methods>/, "");
    const lineRe = /<line\b([^>]*?)\/?>/g;
    let lm;
    while ((lm = lineRe.exec(body))) {
      const num = Number((lm[1].match(/\snumber="(\d+)"/) || [])[1]);
      const hits = Number((lm[1].match(/\shits="(\d+)"/) || [])[1]) || 0;
      if (!num) continue;
      addHit(map, fname, num, hits);
      for (const s of sources) if (s && !path.isAbsolute(fname)) addHit(map, `${s}/${fname}`, num, hits);
    }
  }
  return map;
}

export function lineHitsFromGoCover(text) {
  const map = new Map();
  for (const l of String(text).split(/\r?\n/)) {
    const m = l.match(/^(.+?):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/);
    if (!m) continue;
    for (let ln = Number(m[2]); ln <= Number(m[3]); ln++) addHit(map, m[1], ln, Number(m[4]));
  }
  return map;
}

export function lineHitsFromIstanbulFinal(text) {
  const map = new Map();
  const json = JSON.parse(text);
  for (const [file, data] of Object.entries(json)) {
    for (const [id, loc] of Object.entries(data.statementMap || {})) {
      const hits = Number(data.s?.[id]) || 0;
      for (let ln = loc.start.line; ln <= loc.end.line; ln++) addHit(map, data.path || file, ln, hits);
    }
  }
  return map;
}

export function lineHitsFromReport(file, text) {
  const base = path.basename(file);
  if (base.endsWith(".info") || /^(TN:|SF:)/m.test(text.slice(0, 2000))) return lineHitsFromLcov(text);
  if (/^mode:\s*(set|count|atomic)/m.test(text.slice(0, 200))) return lineHitsFromGoCover(text);
  if (base.endsWith(".json")) return lineHitsFromIstanbulFinal(text);
  if (/<coverage\b/.test(text.slice(0, 4000))) return lineHitsFromCobertura(text);
  throw new Error(`No line-level data in ${base} (use lcov, Cobertura, Go cover or coverage-final.json)`);
}

/** Match a diff path (repo/app relative) to a coverage path (absolute or relative) by suffix. */
export function matchCoverageFile(diffFile, coverageFiles) {
  const d = toPosix(diffFile);
  let best = null;
  for (const c of coverageFiles) {
    const cp = toPosix(c);
    if (cp === d || cp.endsWith(`/${d}`) || d.endsWith(`/${cp}`)) {
      if (!best || cp.length < best.length) best = c;
    }
  }
  return best;
}

/**
 * @param {{ added: Map<string, Set<number>>, hits: Map<string, Map<number, number>>, min?: number, ignore?: string[] }} input
 */
export function evaluateDiffCoverage({ added, hits, min = 0, ignore = [] }) {
  const ignored = makeIgnore(ignore);
  const coverageFiles = [...hits.keys()];
  const files = [];
  let total = 0;
  let covered = 0;
  for (const [file, lines] of added) {
    if (ignored(file)) continue;
    const match = matchCoverageFile(file, coverageFiles);
    if (!match) continue;
    const lineHits = hits.get(match);
    const coverable = [...lines].filter((ln) => lineHits.has(ln));
    if (!coverable.length) continue;
    const hit = coverable.filter((ln) => lineHits.get(ln) > 0);
    const missed = coverable.filter((ln) => !(lineHits.get(ln) > 0)).sort((a, b) => a - b);
    total += coverable.length;
    covered += hit.length;
    files.push({ file, total: coverable.length, covered: hit.length, missed });
  }
  const pct = total ? (covered / total) * 100 : null;
  const ok = pct === null || pct + 1e-9 >= min;
  return { ok, total, covered, pct, min, files: files.sort((a, b) => a.file.localeCompare(b.file)) };
}

function ranges(lines) {
  const out = [];
  for (const ln of lines) {
    const last = out[out.length - 1];
    if (last && ln === last[1] + 1) last[1] = ln;
    else out.push([ln, ln]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

export function renderDiffSummary(result, { mode = "block" } = {}) {
  if (result.pct === null) return "#### Changed lines\n\nNo coverable changed lines.\n";
  const icon = result.ok ? "✅" : mode === "warn" ? "⚠️" : "❌";
  const rows = result.files
    .filter((f) => f.missed.length)
    .slice(0, 30)
    .map((f) => `| ${f.file} | ${f.covered}/${f.total} | ${ranges(f.missed)} |`);
  return [
    "#### Changed lines",
    "",
    `${icon} **${result.pct.toFixed(2)}%** of ${result.total} changed line(s) covered (min ${result.min}%, mode: ${mode})`,
    ...(rows.length ? ["", "| file | covered | uncovered lines |", "|---|---|---|", ...rows] : []),
    "",
  ].join("\n");
}

const LINE_REPORTS = ["coverage/lcov.info", "lcov.info", "coverage.out", "coverage.xml", "coverage/cobertura-coverage.xml", "coverage/coverage-final.json"];

export function findLineReport(dir, explicit = null) {
  if (explicit) {
    const abs = path.resolve(dir, explicit);
    return fs.existsSync(abs) ? abs : null;
  }
  for (const c of LINE_REPORTS) {
    const abs = path.join(dir, c);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** Run the whole check from a working directory (used by coverage-gate --diff-base). */
export function diffCoverageFromGit({ dir, base, file = null, min = 0, ignore = [] }) {
  const report = findLineReport(dir, file);
  if (!report) return { ok: false, missing: true, total: 0, covered: 0, pct: null, min, files: [] };
  const diff = execFileSync("git", ["diff", "-U0", "--no-color", "--relative", `${base}...HEAD`, "--", "."], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const hits = lineHitsFromReport(report, fs.readFileSync(report, "utf8"));
  return { ...evaluateDiffCoverage({ added: parseAddedLines(diff), hits, min, ignore }), report };
}
