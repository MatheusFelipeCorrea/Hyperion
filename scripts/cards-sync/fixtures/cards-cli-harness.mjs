/**
 * Test support for the cards CLI subprocess tests (doctor, labels-reset, init,
 * project-fields-apply, migrate-layout): a throwaway workspace plus a runner that
 * drives the real entry script through runWithFetchMock() with
 *   - fetch routed to cards-cli.route.mjs (state-driven),
 *   - fake `gh` / `git` / `npm` first on PATH (generated into the temp dir, see
 *     writeFakeBins / writeFakeNpm),
 *   - every backend/token/cards env var scrubbed, then GITHUB_REPOSITORY=acme/app
 *     and PROJECT_SYNC_TOKEN=test-token unless the test overrides them.
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
const FETCH_PRELOAD = pathToFileURL(join(CARDS_SYNC_DIR, "..", "hyperion", "fetch-mock-preload.mjs")).href;
const TTY_PRELOAD = pathToFileURL(join(fixturesDir, "cards-cli-tty-preload.mjs")).href;
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";

/**
 * Stand-in for `gh` and `git`, written next to the wrappers in each workspace's
 * bin/ (a generated file, so the kit's coverage gate never counts it). Behavior
 * is driven by env vars (all optional — unset means "fail"):
 *   FAKE_GH_TOKEN        `gh auth token` output
 *   FAKE_GH_LABELS       JSON array of names for `gh label list`
 *   FAKE_GH_FAIL_NAMES   comma list of label names whose delete/edit/create fails
 *   FAKE_GIT_ORIGIN      `git remote get-url origin` output
 *   FAKE_GIT_HOOKS       `git rev-parse --git-path hooks` output
 *   FAKE_TOOL_LOG        file that gets one JSON line per invocation
 */
const FAKE_TOOL_SOURCE = String.raw`import { appendFileSync } from "node:fs";
const env = process.env;
const [tool, ...args] = process.argv.slice(2);
const cmd = args.join(" ");
if (env.FAKE_TOOL_LOG) appendFileSync(env.FAKE_TOOL_LOG, JSON.stringify({ tool, args }) + "\n");
const out = (text) => { process.stdout.write(text + "\n"); process.exit(0); };
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(1); };
if (tool === "gh" && cmd === "auth token") env.FAKE_GH_TOKEN ? out(env.FAKE_GH_TOKEN) : fail("gh: not logged in");
if (tool === "gh" && args[0] === "label" && args[1] === "list") {
  if (!env.FAKE_GH_LABELS) fail("gh: label list failed");
  out(JSON.stringify(JSON.parse(env.FAKE_GH_LABELS).map((name) => ({ name }))));
}
if (tool === "gh" && args[0] === "label") {
  if ((env.FAKE_GH_FAIL_NAMES || "").split(",").filter(Boolean).includes(args[2])) fail("gh: cannot " + args[1] + " " + args[2]);
  out("");
}
if (tool === "git" && cmd === "remote get-url origin") env.FAKE_GIT_ORIGIN ? out(env.FAKE_GIT_ORIGIN) : fail("fatal: not a git repository");
if (tool === "git" && cmd === "rev-parse --git-path hooks") env.FAKE_GIT_HOOKS ? out(env.FAKE_GIT_HOOKS) : fail("fatal: not a git repository");
fail("fake " + tool + ": unsupported invocation: " + cmd);
`;

/** Prefixes of env vars read by scripts/cards-sync (or the fakes above); all are dropped before each run. */
const SCRUBBED_ENV_PREFIX = /^(CARDS_|SYNC_|JIRA_|AZDO_|GITLAB_|LINEAR_|FAKE_)/i;
const SCRUBBED_ENV = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_BASE_SHA",
  "GITHUB_EVENT_BEFORE",
  "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  "PROJECT_SYNC_TOKEN",
  "PROJECT_OWNER",
  "PROJECT_NUMBER",
  "HYPERION_ROOT",
  "CARDS_SYNC_BACKEND",
  "CARDS_SYNC_YES",
  "CARDS_SYNC_ONLY",
  "CARDS_SYNC_INCLUDE_SAMPLES",
  "CARDS_SYNC_INCLUDE_EXAMPLES",
  "CARDS_SYNC_CONCURRENCY",
  "CARDS_CI_REQUIRE_PROJECT",
  "CARDS_CI_STRICT_GIT",
  "CARDS_CI_SKIP_REVERSE",
  "CARDS_CI_SKIP_BOARD_GUARD",
  "CARDS_CI_SKIP_POST_VERIFY",
  "CARDS_GUARD_BASE_REF",
  "CARDS_PR_GUARD_SKIP",
  "CARDS_PR_HEAD_SHA",
  "CARDS_PR_CHECK_NAME",
  "CARDS_WATCH_ANY_BRANCH",
  "CARDS_WATCH_LIVE",
  "CREATE_MISSING_LABELS",
  "DRY_RUN",
  "SYNC_DIRECTION",
  "SLACK_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
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
];

function writeScript(binDir, tool, { cmd, sh }) {
  if (process.platform === "win32") {
    writeFileSync(join(binDir, `${tool}.cmd`), `@echo off\r\n${cmd.join("\r\n")}\r\n`);
  } else {
    const file = join(binDir, tool);
    writeFileSync(file, `#!/bin/sh\n${sh.join("\n")}\n`);
    chmodSync(file, 0o755);
  }
}

function writeFakeBins(binDir) {
  mkdirSync(binDir, { recursive: true });
  const fakeTool = join(binDir, "fake-tool.mjs");
  writeFileSync(fakeTool, FAKE_TOOL_SOURCE);
  for (const tool of ["gh", "git"]) {
    // The fake tools aren't under test: drop coverage collection and preloads so each call stays fast.
    writeScript(binDir, tool, {
      cmd: ["set NODE_V8_COVERAGE=", "set NODE_OPTIONS=", `"${process.execPath}" "${fakeTool}" ${tool} %*`],
      sh: ["unset NODE_V8_COVERAGE NODE_OPTIONS", `exec "${process.execPath}" "${fakeTool}" ${tool} "$@"`],
    });
  }
  writeFakeNpm(binDir, {});
}

/**
 * `npm view <pkg> time.modified` answers from `modified` ({ pkg: isoDate }), anything else fails.
 * A plain shell script rather than Node: doctor gives each lookup a 5s timeout, and on Windows that
 * timeout kills only cmd.exe, so a slow Node child would outlive the run and pin the temp dir.
 * Logs `npm <args>` (unquoted) to FAKE_TOOL_LOG.
 */
function writeFakeNpm(binDir, modified) {
  const entries = Object.entries(modified);
  for (const value of entries.flat()) {
    if (!/^[\w@/.:+-]+$/.test(value)) throw new Error(`fake npm: unsafe value ${JSON.stringify(value)}`);
  }
  writeScript(binDir, "npm", {
    cmd: [
      '>>"%FAKE_TOOL_LOG%" echo npm %*',
      'if not "%~1 %~3"=="view time.modified" goto fail',
      ...entries.map(([pkg, date]) => `if "%~2"=="${pkg}" (echo ${date}& exit /b 0)`),
      ":fail",
      ">&2 echo npm ERR! 404",
      "exit /b 1",
    ],
    sh: [
      'echo "npm $*" >> "$FAKE_TOOL_LOG"',
      'if [ "$1 $3" = "view time.modified" ]; then',
      ...entries.map(([pkg, date]) => `  [ "$2" = "${pkg}" ] && echo "${date}" && exit 0`),
      "fi",
      'echo "npm ERR! 404" >&2',
      "exit 1",
    ],
  });
}

function parseToolLog(line) {
  if (line.startsWith("{")) return JSON.parse(line);
  const [tool, ...args] = line.trim().split(/\s+/);
  return { tool, args };
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
    // Runs from `finally` blocks: a leftover handle (Windows EPERM/EBUSY) must not mask the test's own failure.
    cleanup: () => {
      try {
        rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (err) {
        console.warn(`[cards-cli-harness] could not remove ${base}: ${err.message}`);
      }
    },
  };

  if (config !== undefined) ws.write(".github/cards/config/projects-map.json", config);
  if (projectYml !== undefined) ws.write(".github/project.yml", projectYml);
  for (const [rel, content] of Object.entries(files)) ws.write(rel, content);
  return ws;
}

/**
 * Runs scripts/cards-sync/<script> in `ws`.
 * @param {{ ws: object, env?: object, state?: object, input?: string, tty?: boolean, chain?: boolean, npmModified?: Record<string, string> }} opts
 *   tty         — stdin reports isTTY (prompts answered from `input`);
 *   chain       — also mock fetch in grandchild processes (scripts that spawn other scripts);
 *   npmModified — { pkg: isoDate } answered by the fake `npm view <pkg> time.modified`.
 * @returns runWithFetchMock result + `out` (stdout+stderr) and `tools` (fake gh/git/npm invocations).
 */
export function runCli(script, args = [], { ws, env = {}, state, input, tty = false, chain = false, npmModified = {} } = {}) {
  const nodeOptions = [process.env.NODE_OPTIONS, chain && `--import=${FETCH_PRELOAD}`, tty && `--import=${TTY_PRELOAD}`]
    .filter(Boolean)
    .join(" ");
  const scrubbed = [...SCRUBBED_ENV, ...Object.keys(process.env).filter((k) => SCRUBBED_ENV_PREFIX.test(k))];
  const childEnv = Object.fromEntries(scrubbed.map((k) => [k, undefined]));
  Object.assign(childEnv, {
    GITHUB_REPOSITORY: "acme/app",
    PROJECT_SYNC_TOKEN: "test-token",
    FAKE_TOOL_LOG: ws.toolLog,
    NODE_OPTIONS: nodeOptions || undefined,
    [PATH_KEY]: `${ws.binDir}${delimiter}${process.env[PATH_KEY] || ""}`,
    ...env,
  });

  rmSync(ws.toolLog, { force: true });
  writeFakeNpm(ws.binDir, npmModified);
  const result = runWithFetchMock(join(CARDS_SYNC_DIR, script), args, {
    cwd: ws.root,
    route: ROUTE,
    state: state || {},
    env: childEnv,
    input,
  });
  const tools = existsSync(ws.toolLog)
    ? readFileSync(ws.toolLog, "utf8").trim().split("\n").filter((line) => line.trim()).map(parseToolLog)
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
