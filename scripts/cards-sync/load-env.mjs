/**
 * Loads `.env.local`, then `.env`, from the working directory into process.env,
 * never overriding a variable that is already set. Lets a contributor point the
 * cards scripts at their own board (PROJECT_NUMBER, PROJECT_OWNER,
 * PROJECT_SYNC_TOKEN) with nothing committed — both files are gitignored.
 *
 * Only keys the Hyperion scripts read are loaded (ALLOWED_KEYS /
 * ALLOWED_PREFIXES): a product's `.env` also holds its own app settings, and
 * those must not leak into the cards scripts or the processes they spawn.
 *
 * Import it first in an entry script: `import "./load-env.mjs";`
 * Loads only when the process entry point is one of ENTRY_SCRIPTS (so test
 * files importing those modules never pick up a developer's `.env`), and
 * never in CI or with HYPERION_NO_DOTENV=1.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as util from "node:util";

export const ENV_FILES = [".env.local", ".env"];

export const ENTRY_SCRIPTS = new Set([
  "sync.mjs",
  "doctor.mjs",
  "ci-sync.mjs",
  "init.mjs",
  "watch.mjs",
  "labels-reset.mjs",
  "pr-board-guard.mjs",
  "project-fields-apply.mjs",
]);

export const ALLOWED_KEYS = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_REPOSITORY",
  "PROJECT_SYNC_TOKEN",
  "PROJECT_NUMBER",
  "PROJECT_OWNER",
  "DRY_RUN",
  "SYNC_DIRECTION",
  "CREATE_MISSING_LABELS",
  "SLACK_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
]);

export const ALLOWED_PREFIXES = ["CARDS_", "HYPERION_", "JIRA_", "LINEAR_", "AZDO_", "AZURE_", "GITLAB_"];

export function isAllowedKey(key) {
  return ALLOWED_KEYS.has(key) || ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Minimal dotenv parser for Node < 20.12 (no util.parseEnv): `KEY=value`,
 * optional `export `, `#` comments, single/double/backtick quotes (`\n` in
 * double quotes). No multi-line values.
 */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    const end = quote === '"' || quote === "'" || quote === "`" ? value.indexOf(quote, 1) : -1;
    if (end > 0) {
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = value;
  }
  return out;
}

const defaultParse = typeof util.parseEnv === "function" ? util.parseEnv : parseDotenv;

export function loadLocalEnv(root = process.cwd(), env = process.env, { parse = defaultParse } = {}) {
  const loaded = [];
  for (const name of ENV_FILES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    for (const [key, value] of Object.entries(parse(text))) {
      if (!isAllowedKey(key) || env[key] !== undefined) continue;
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

export function shouldAutoLoad(entry = process.argv[1], env = process.env) {
  if (String(env.CI || "").toLowerCase() === "true" || env.HYPERION_NO_DOTENV === "1") return false;
  if (!entry) return false;
  const abs = resolve(entry);
  return basename(dirname(abs)) === "cards-sync" && ENTRY_SCRIPTS.has(basename(abs));
}

if (shouldAutoLoad()) loadLocalEnv();
