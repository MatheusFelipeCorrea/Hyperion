/**
 * GitHub Actions error annotations for kit scripts.
 *
 * Plain console output stays as is; inside Actions (GITHUB_ACTIONS=true) a
 * failing script also emits `::error title=…::…` so the reason and the fix show
 * up on the run page and in the PR diff, not only as "exit code 1" in the log.
 * No dependencies: product CI runs kit scripts without npm install.
 */
import { isAbsolute, relative } from "node:path";
import { resolveLanguages, t } from "./i18n.mjs";

/** GitHub shows at most 10 error annotations per step; keep room for the summary one. */
export const MAX_FILE_ANNOTATIONS = 8;

export const inActions = (env = process.env) => env.GITHUB_ACTIONS === "true";

export function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** `::error title=T,file=F,line=L::message` */
export function formatAnnotation(message, { title, file, line, level = "error" } = {}) {
  const props = [
    title && `title=${escapeProperty(title)}`,
    file && `file=${escapeProperty(String(file).replace(/\\/g, "/"))}`,
    line && `line=${Number(line)}`,
  ].filter(Boolean);
  return `::${level}${props.length ? ` ${props.join(",")}` : ""}::${escapeData(message)}`;
}

/**
 * Annotation paths must be relative to the checkout (GITHUB_WORKSPACE) for GitHub
 * to pin them in the diff; absolute paths are rebased, relative ones kept as given.
 */
export function repoRelative(file, env = process.env) {
  if (!file) return file;
  const rel = isAbsolute(file) ? relative(env.GITHUB_WORKSPACE || process.cwd(), file) : file;
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Emits an error annotation when running in GitHub Actions; no-op elsewhere. */
export function ciError(message, opts = {}, { env = process.env, write = (s) => console.error(s) } = {}) {
  if (inActions(env)) write(formatAnnotation(message, { ...opts, file: repoRelative(opts.file, env) }));
}

/**
 * Localized annotation for product-facing scripts: title from `<key>Title`, message
 * from `<key>` (or `message` when the text comes from elsewhere), in the repo's language.
 */
export function ciFail(root, key, vars = {}, { message, ...opts } = {}, io = {}) {
  if (!inActions(io.env)) return;
  const lang = resolveLanguages(root).primary;
  ciError(message ?? t(key, vars, lang, { root }), { ...opts, title: t(`${key}Title`, vars, lang, { root }) }, io);
}

/** {@link ciErrorList} with the title and closing summary localized from `<key>Title` / `<key>`. */
export function ciFailList(root, key, problems, vars = {}, io = {}) {
  if (!inActions(io.env)) return;
  const lang = resolveLanguages(root).primary;
  ciErrorList(t(`${key}Title`, vars, lang, { root }), problems, t(key, vars, lang, { root }), io, {
    more: (count) => t("cards.fail.more", { count }, lang, { root }),
  });
}

/** "path/to/file.md: problem" → { file, message } (file only when the prefix looks like a path). */
export function splitFileMessage(text) {
  const m = String(text).match(/^([\w.@/\\-]+\.[\w]+)(?::(\d+))?:\s+(.+)$/s);
  return m ? { file: m[1], line: m[2] ? Number(m[2]) : undefined, message: m[3] } : { message: String(text) };
}

/**
 * One annotation per problem (pinned to its file when it names one), capped, plus
 * one summary annotation that says how to fix and reproduce.
 */
export function ciErrorList(title, problems, summary, io = {}, { more = (count) => `${count} more in the log` } = {}) {
  for (const p of problems.slice(0, MAX_FILE_ANNOTATIONS)) {
    const item = typeof p === "string" ? splitFileMessage(p) : p;
    ciError(item.message, { title, file: item.file, line: item.line }, io);
  }
  const hidden = problems.length - MAX_FILE_ANNOTATIONS;
  ciError(hidden > 0 ? `${summary} (${more(hidden)})` : summary, { title }, io);
}
