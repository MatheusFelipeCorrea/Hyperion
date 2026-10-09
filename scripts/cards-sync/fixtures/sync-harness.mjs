/**
 * Test support: drive scripts/cards-sync/sync.mjs end-to-end as a subprocess
 * against the fake GitHub in fake-github.mjs, inside a throwaway workspace.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runWithFetchMock } from "../../hyperion/fetch-mock.mjs";
import { withDefaults } from "./fake-github.mjs";

export const SYNC_SCRIPT = fileURLToPath(new URL("../sync.mjs", import.meta.url));
export const FAKE_GITHUB = fileURLToPath(new URL("./fake-github.mjs", import.meta.url));
export const TTY_PRELOAD = pathToFileURL(fileURLToPath(new URL("./tty-stdin.mjs", import.meta.url))).href;

const yamlValue = (value) => (value === null || value === undefined ? "null" : JSON.stringify(value));

/** Card markdown; `extra` adds raw frontmatter lines, `categories` a YAML list. */
export function card({ id, title = `Card ${id}`, type = "Story", status = null, priority = null, sprint = null, storyPoints = null, reporter = null, parent = null, dueDate = null, categories = [], extra = [], body = `# ${title}\n\nBody of ${id}.` }) {
  const lines = [
    "---",
    `card_id: ${id}`,
    `title: ${yamlValue(title)}`,
    `status: ${yamlValue(status)}`,
    `type: ${yamlValue(type)}`,
    `priority: ${yamlValue(priority)}`,
    `sprint: ${yamlValue(sprint)}`,
    `story_points: ${storyPoints ?? "null"}`,
    `reporter: ${yamlValue(reporter)}`,
    `parent: ${yamlValue(parent)}`,
    `due_date: ${yamlValue(dueDate)}`,
    ...extra,
    categories.length ? `categories:\n${categories.map((c) => `  - ${c}`).join("\n")}` : "categories: []",
    "---",
    "",
    body,
    "",
  ];
  return lines.join("\n");
}

/** Issue body as written by the forward sync (SYNC_METADATA block). */
export function issueBody({ cardId, sourceFile = null, body = "Remote body", meta = {} }) {
  const lines = [body, "", "---", "<!-- SYNC_METADATA — do not edit below this line -->"];
  if (cardId) lines.push(`CARD_ID: ${cardId}`);
  if (sourceFile) lines.push(`SOURCE_FILE: ${sourceFile}`);
  for (const [key, value] of Object.entries(meta)) lines.push(`${key}: ${value}`);
  lines.push("<!-- /SYNC_METADATA -->");
  return lines.join("\n");
}

/** projects-map.json content with inline labels (never reads the repo's own catalogs). */
export function projectsMap(overrides = {}, extra = {}) {
  return {
    default: {
      projectOwner: null,
      projectNumber: null,
      locale: "en",
      fieldMap: {},
      defaults: { status: "Backlog" },
      labels: [],
      ...overrides,
    },
    ...extra,
  };
}

/**
 * @param {{ cards?: Record<string,string>, config?: object|null, files?: Record<string,string> }} opts
 *   cards: paths relative to .github/cards; files: paths relative to the workspace root.
 */
export function makeWorkspace({ cards = {}, config = projectsMap(), files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hyperion-sync-"));
  const ws = {
    root,
    path: (rel) => join(root, rel),
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    write: (rel, content) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    },
    readJson: (rel) => JSON.parse(readFileSync(join(root, rel), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  mkdirSync(join(root, ".github", "cards", "config"), { recursive: true });
  if (config) ws.write(".github/cards/config/projects-map.json", JSON.stringify(config, null, 2));
  for (const [rel, content] of Object.entries(cards)) ws.write(`.github/cards/${rel}`, content);
  for (const [rel, content] of Object.entries(files)) ws.write(rel, content);
  return ws;
}

/**
 * Directory holding fake `gh` / `git` executables (cross-platform) that print `outputs[name]`.
 * Pass it as PATH to steer sync.mjs's token/repo auto-detection without touching real CLIs.
 * The output lives in a sidecar `<name>.out` file so shell metacharacters (& | < > ^ % ')
 * and empty strings are printed verbatim.
 */
export function fakeBin(ws, outputs = {}) {
  const dir = ws.path("fake-bin");
  mkdirSync(dir, { recursive: true });
  for (const [name, output] of Object.entries(outputs)) {
    writeFileSync(join(dir, `${name}.out`), output ? `${output}\n` : "");
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${name}.cmd`), `@type "%~dp0${name}.out"\r\n`);
    } else {
      // Shell builtins only (read/printf): tests set PATH to this directory alone, so `cat`/`dirname` would not resolve.
      writeFileSync(
        join(dir, name),
        `#!/bin/sh\nwhile IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$0.out"\n`
      );
      chmodSync(join(dir, name), 0o755);
    }
  }
  return dir;
}

const CLEAN_ENV = {
  GITHUB_REPOSITORY: "acme/app",
  PROJECT_SYNC_TOKEN: "test-token",
  GITHUB_TOKEN: undefined,
  CARDS_SYNC_CONCURRENCY: "1",
  CARDS_SYNC_BACKEND: undefined,
  CARDS_SYNC_ONLY: undefined,
  CARDS_SYNC_YES: undefined,
  CARDS_SYNC_INCLUDE_SAMPLES: undefined,
  CARDS_SYNC_INCLUDE_EXAMPLES: undefined,
  CARDS_CI_REQUIRE_PROJECT: undefined,
  CREATE_MISSING_LABELS: undefined,
  DRY_RUN: undefined,
  SYNC_DIRECTION: undefined,
  PROJECT_OWNER: undefined,
  PROJECT_NUMBER: undefined,
  HYPERION_ROOT: undefined,
  JIRA_URL: undefined,
  JIRA_PROJECT_KEY: undefined,
  JIRA_EMAIL: undefined,
  JIRA_API_TOKEN: undefined,
  JIRA_ISSUE_TYPE: undefined,
  AZDO_ORG_URL: undefined,
  AZDO_PROJECT: undefined,
  AZDO_PAT: undefined,
  AZDO_WORK_ITEM_TYPE: undefined,
  LINEAR_TEAM_ID: undefined,
  LINEAR_API_TOKEN: undefined,
  GITLAB_URL: undefined,
  GITLAB_PROJECT_ID: undefined,
  GITLAB_TOKEN: undefined,
  GITLAB_ISSUE_TYPE: undefined,
};

/**
 * Runs sync.mjs in `ws` with fetch routed to the fake GitHub.
 * @returns run result plus `logs` (stdout without the [cards-sync] prefix), `actions`
 *   (JSON lines of the SYNC COMPLETE summary) and the final fake `state`.
 */
export function runSync(ws, args = [], { state = {}, env = {}, input } = {}) {
  const run = runWithFetchMock(SYNC_SCRIPT, args, {
    cwd: ws.root,
    route: FAKE_GITHUB,
    state: withDefaults(structuredClone(state)),
    env: { ...CLEAN_ENV, GIT_CEILING_DIRECTORIES: dirname(ws.root), ...env },
    input,
  });
  const logs = run.stdout.split(/\r?\n/).map((line) => line.replace(/^\[cards-sync\] ?/, ""));
  const actions = logs.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  return { ...run, logs, actions, output: `${run.stdout}\n${run.stderr}` };
}

export function issueByCard(state, cardId) {
  return state.issues.find((i) => String(i.body || "").split("\n").includes(`CARD_ID: ${cardId}`));
}

/** Single-select field in the fake project shape. */
export function selectField(id, name, options) {
  return {
    __typename: "ProjectV2SingleSelectField",
    id,
    name,
    options: options.map((o, i) => (typeof o === "string" ? { id: `${id}_o${i}`, name: o, color: "GRAY", description: "" } : o)),
  };
}

export function iterationField(id, name, titles) {
  return { __typename: "ProjectV2IterationField", id, name, configuration: { iterations: titles.map((title, i) => ({ id: `${id}_it${i}`, title })) } };
}

export function plainField(id, name, dataType) {
  return { __typename: "ProjectV2Field", id, name, dataType };
}

export function project({ number = 1, scope = "user", title = "Board", repos = ["acme/app"], fields = [], items = [], views = [] } = {}) {
  return { id: `PVT_${number}`, number, scope, title, repos, fields, items, views };
}
