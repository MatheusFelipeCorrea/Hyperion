/**
 * Test support for the cards CLI subprocess tests (doctor, labels-reset, init,
 * project-fields-apply, migrate-layout): a throwaway workspace plus a runner that
 * drives the real entry script through runWithFetchMock() with
 *   - fetch routed to cards-cli.route.mjs (state-driven),
 *   - fake `gh` / `git` / `npm` first on PATH (cards-cli-fake-tool.mjs),
 *   - every backend/token env var scrubbed, then GITHUB_REPOSITORY=acme/app and
 *     PROJECT_SYNC_TOKEN=test-token unless the test overrides them.
 *
 *   const ws = createWorkspace({ config: { default: {...} } });
 *   const run = runCli("doctor.mjs", ["--yes"], { ws, state: { github: {...} } });
 *   ws.cleanup();
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runWithFetchMock } from "../../hyperion/fetch-mock.mjs";

const fixturesDir = dirname(fileURLToPath(import.meta.url));
export const CARDS_SYNC_DIR = dirname(fixturesDir);
const ROUTE = join(fixturesDir, "cards-cli.route.mjs");
const FAKE_TOOL = join(fixturesDir, "cards-cli-fake-tool.mjs");
const FETCH_PRELOAD = pathToFileURL(join(CARDS_SYNC_DIR, "..", "hyperion", "fetch-mock-preload.mjs")).href;
const TTY_PRELOAD = pathToFileURL(join(fixturesDir, "cards-cli-tty-preload.mjs")).href;
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";

const SCRUBBED_ENV = [
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "PROJECT_SYNC_TOKEN",
  "PROJECT_OWNER",
  "PROJECT_NUMBER",
  "HYPERION_ROOT",
  "CARDS_SYNC_BACKEND",
  "CARDS_SYNC_YES",
  "CREATE_MISSING_LABELS",
  "DRY_RUN",
  "SYNC_DIRECTION",
  "JIRA_URL",
  "JIRA_PROJECT_KEY",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_ISSUE_TYPE",
  "AZDO_ORG_URL",
  "AZDO_PROJECT",
  "AZDO_PAT",
  "AZDO_WORK_ITEM_TYPE",
  "GITLAB_URL",
  "GITLAB_PROJECT_ID",
  "GITLAB_TOKEN",
  "GITLAB_ISSUE_TYPE",
  "LINEAR_TEAM_ID",
  "LINEAR_API_TOKEN",
  "FAKE_GH_TOKEN",
  "FAKE_GH_LABELS",
  "FAKE_GH_FAIL_NAMES",
  "FAKE_GIT_ORIGIN",
  "FAKE_GIT_HOOKS",
  "FAKE_NPM_MODIFIED",
];

function writeFakeBins(binDir) {
  mkdirSync(binDir, { recursive: true });
  for (const tool of ["gh", "git", "npm"]) {
    // The fake tools aren't under test: drop coverage collection and preloads so each call stays fast.
    if (process.platform === "win32") {
      writeFileSync(
        join(binDir, `${tool}.cmd`),
        `@set NODE_V8_COVERAGE=\r\n@set NODE_OPTIONS=\r\n@"${process.execPath}" "${FAKE_TOOL}" ${tool} %*\r\n`
      );
    } else {
      const file = join(binDir, tool);
      writeFileSync(file, `#!/bin/sh\nunset NODE_V8_COVERAGE NODE_OPTIONS\nexec "${process.execPath}" "${FAKE_TOOL}" ${tool} "$@"\n`);
      chmodSync(file, 0o755);
    }
  }
}

/**
 * @param {{ config?: object|string, projectYml?: string, files?: Record<string, string> }} opts
 *   config → .github/cards/config/projects-map.json (string written verbatim);
 *   files  → paths relative to the workspace root.
 */
export function createWorkspace({ config, projectYml, files = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), "hyperion-cards-cli-"));
  const root = join(base, "ws");
  const binDir = join(base, "bin");
  const toolLog = join(base, "tools.log");
  mkdirSync(root);
  writeFakeBins(binDir);

  const ws = {
    root,
    binDir,
    toolLog,
    path: (rel) => join(root, rel),
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    readJson: (rel) => JSON.parse(readFileSync(join(root, rel), "utf8")),
    write: (rel, content) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };

  if (config !== undefined) ws.write(".github/cards/config/projects-map.json", config);
  if (projectYml !== undefined) ws.write(".github/project.yml", projectYml);
  for (const [rel, content] of Object.entries(files)) ws.write(rel, content);
  return ws;
}

/**
 * Runs scripts/cards-sync/<script> in `ws`.
 * @param {{ ws: object, env?: object, state?: object, input?: string, tty?: boolean, chain?: boolean }} opts
 *   tty   — stdin reports isTTY (prompts answered from `input`);
 *   chain — also mock fetch in grandchild processes (scripts that spawn other scripts).
 * @returns runWithFetchMock result + `out` (stdout+stderr) and `tools` (fake gh/git/npm invocations).
 */
export function runCli(script, args = [], { ws, env = {}, state, input, tty = false, chain = false } = {}) {
  const nodeOptions = [process.env.NODE_OPTIONS, chain && `--import=${FETCH_PRELOAD}`, tty && `--import=${TTY_PRELOAD}`]
    .filter(Boolean)
    .join(" ");
  const childEnv = Object.fromEntries(SCRUBBED_ENV.map((k) => [k, undefined]));
  Object.assign(childEnv, {
    GITHUB_REPOSITORY: "acme/app",
    PROJECT_SYNC_TOKEN: "test-token",
    FAKE_TOOL_LOG: ws.toolLog,
    NODE_OPTIONS: nodeOptions || undefined,
    [PATH_KEY]: `${ws.binDir}${delimiter}${process.env[PATH_KEY] || ""}`,
    ...env,
  });

  rmSync(ws.toolLog, { force: true });
  const result = runWithFetchMock(join(CARDS_SYNC_DIR, script), args, {
    cwd: ws.root,
    route: ROUTE,
    state: state || {},
    env: childEnv,
    input,
  });
  const tools = existsSync(ws.toolLog)
    ? readFileSync(ws.toolLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { ...result, out: `${result.stdout}${result.stderr}`, tools };
}

/** Fields of a Project that passes every doctor check (all names default, Status has the 7 Hyperion columns). */
export const HEALTHY_PROJECT_FIELDS = [
  {
    __typename: "ProjectV2SingleSelectField",
    id: "F_status",
    name: "Status",
    options: ["Backlog", "Functional Refinement", "Technical Refinement", "In Progress", "In Tests", "In Revision", "Done"].map(
      (name, i) => ({ id: `opt${i}`, name })
    ),
  },
  { __typename: "ProjectV2SingleSelectField", id: "F_type", name: "Type", options: [] },
  { __typename: "ProjectV2SingleSelectField", id: "F_priority", name: "Priority", options: [] },
  { __typename: "ProjectV2IterationField", id: "F_sprint", name: "Sprint", configuration: { iterations: [{ id: "it1", title: "Sprint 1" }] } },
  { __typename: "ProjectV2Field", id: "F_sp", name: "Story Points", dataType: "NUMBER" },
  { __typename: "ProjectV2Field", id: "F_rep", name: "Reporter", dataType: "TEXT" },
  { __typename: "ProjectV2Field", id: "F_parent", name: "Parent (Epic/Feature)", dataType: "TEXT" },
  { __typename: "ProjectV2Field", id: "F_due", name: "Due Date", dataType: "DATE" },
];
