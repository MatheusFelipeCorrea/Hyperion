/**
 * Test support for the kit's CLIs: run an entry script as a subprocess in a temp
 * workspace (code executed there still counts toward
 * `node --test --experimental-test-coverage`), with a scrubbed environment and
 * optional PATH stubs for `gh` / `npm`, so nothing touches the network, the real
 * GitHub CLI session or this checkout.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const hyperionDir = resolve(here, "..");
export const repoRoot = resolve(hyperionDir, "..", "..");
export const relocatePreload = pathToFileURL(join(here, "relocate-preload.mjs")).href;
export const fetchMockPreload = pathToFileURL(join(hyperionDir, "fetch-mock-preload.mjs")).href;
const faultPreload = pathToFileURL(join(here, "fault-preload.mjs")).href;
/** `nodeArgs` for runNode() that make spawnSync throw in the entry process only. */
export const FAULT_SPAWN = ["--import", faultPreload];
/** Env that makes spawnSync throw only in a descendant node process running `entryBasename`. */
export function faultEnv(entryBasename) {
  return { NODE_OPTIONS: `--import ${faultPreload}`, HYPERION_FAULT_ENTRY: entryBasename };
}
/** Parent of every temp dir made here; children's git never looks for a repo above it. */
const tmpRoot = realpathSync.native(tmpdir());

/** Env vars that would make a run depend on the developer's machine or CI (every GITHUB_* too). */
const SCRUBBED = [
  "HYPERION_ROOT",
  "HYPERION_KIT_ROOT",
  "HYPERION_ORIGIN_REPO",
  "HYPERION_ORIGIN_REF",
  "HYPERION_TELEMETRY",
  "HYPERION_FETCH_MOCK",
  "HYPERION_FETCH_LOG",
  "HYPERION_FETCH_STATE",
  "HYPERION_RELOCATE_FROM",
  "HYPERION_RELOCATE_TO",
  "CI",
  "GH_TOKEN",
  "PROJECT_SYNC_TOKEN",
  "PROJECT_NUMBER",
  "PROJECT_OWNER",
  "CARDS_SYNC_BACKEND",
  "DRY_RUN",
  "NODE_OPTIONS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG_COUNT",
];
const isScrubbed = (key) => SCRUBBED.includes(key.toUpperCase()) || key.toUpperCase().startsWith("GITHUB_");

const created = [];

export function makeTmp(prefix = "hyperion-cli-") {
  const dir = mkdtempSync(join(tmpRoot, prefix));
  created.push(dir);
  return dir;
}

export function cleanupTmp() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  nodeCopy = null;
  hooksDir = null;
}

/** Write `{ "rel/path": string | object (as JSON) | null (skip) }` under root. */
export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

/**
 * Child env: the current one minus SCRUBBED (and CI / GITHUB_*), then `extra`
 * (opt back in there; undefined deletes a key).
 * `binDir` is prepended to PATH (case-insensitively — Windows spells it `Path`).
 */
export function childEnv(extra = {}, { binDir = null } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isScrubbed(key)));
  Object.assign(env, { HYPERION_NO_DOTENV: "1", GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: tmpRoot });
  if (binDir) {
    const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
    const paths = pathKeys.map((k) => env[k]);
    for (const k of pathKeys) delete env[k];
    env.PATH = [binDir, ...paths].join(delimiter);
  }
  Object.assign(env, extra);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

/** Run a script with node as a subprocess. */
export function runNode(script, args = [], { cwd, env = {}, binDir = null, input, nodeArgs = [] } = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    cwd,
    env: childEnv(env, { binDir }),
    encoding: "utf8",
    input,
    timeout: 120_000,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: `${r.stdout || ""}${r.stderr || ""}` };
}

/**
 * Env that swaps fetch in the entry script AND every node child it spawns
 * (NODE_OPTIONS), answering with the route module source given here.
 */
export function fetchMockEnv(routeSource) {
  const file = join(makeTmp("hyperion-route-"), "route.mjs");
  writeFileSync(file, routeSource);
  return { NODE_OPTIONS: `--import ${fetchMockPreload}`, HYPERION_FETCH_MOCK: file };
}

/** Linear GraphQL: the team exists and has no issues. */
export const LINEAR_ROUTE = `export default (req) =>
  req.url.startsWith("https://api.linear.app/")
    ? { data: { team: { id: "t", name: "Team", issues: { nodes: [], pageInfo: { hasNextPage: false } } } } }
    : undefined;
`;

/** Cards backend env for a Linear board answered by LINEAR_ROUTE (no network). */
export function linearEnv({ token = true } = {}) {
  return {
    GITHUB_REPOSITORY: "acme/app",
    PROJECT_SYNC_TOKEN: token ? "test-token" : undefined,
    LINEAR_TEAM_ID: "t",
    LINEAR_API_TOKEN: "k",
    ...fetchMockEnv(LINEAR_ROUTE),
  };
}

/**
 * A legacy-layout (kit at the root) workspace that passes collectHyperionHealth.
 * Pass `null` for a default file to leave it out.
 */
export function kitWorkspace(files = {}, { backend = "linear", gitRemote = false } = {}) {
  const root = writeFiles(makeTmp("hyperion-ws-"), {
    ".github/cards/config/projects-map.json": { default: { backend, locale: "en" } },
    ".github/project.yml": "version: 1\nname: App\nlocale: en\n",
    ".github/memory/PROJECT.md": "# Project\n\n## Vision\n\nA real product.\n",
    ".cursor/rules/hyperion.mdc": "rules\n",
    "package.json": { name: "app", private: true },
    ...files,
  });
  if (gitRemote) {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
  }
  return root;
}

/** Same as runNode() but non-blocking, so independent CLI runs can go concurrently. */
export function runNodeAsync(script, args = [], { cwd, env = {}, binDir = null, input, nodeArgs = [] } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, script, ...args], {
      cwd,
      env: childEnv(env, { binDir }),
      windowsHide: true,
      timeout: 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr, out: `${stdout}${stderr}` }));
    child.stdin.end(input ?? "");
  });
}

/** NODE_OPTIONS value that relocates `from` to `to` (see relocate-preload.mjs) in every node child. */
export function relocateEnv(from, to) {
  return {
    NODE_OPTIONS: `--import ${relocatePreload}`,
    HYPERION_RELOCATE_FROM: from,
    HYPERION_RELOCATE_TO: to,
  };
}

let nodeCopy = null;

/** One copy of the node binary per test process (hard-linked into bin dirs, not re-copied). */
function nodeBinary() {
  if (!nodeCopy) {
    nodeCopy = join(makeTmp("hyperion-node-"), "node.exe");
    copyFileSync(process.execPath, nodeCopy);
  }
  return nodeCopy;
}

/**
 * Directory with fake `gh` / `npm` executables, to prepend to PATH.
 *   gh: "fail" → every call fails (as if gh were missing or logged out)
 *       "node" → gh is node itself, so `gh <sub> ...` runs the file `<sub>` in the cwd
 *                (write e.g. `auth`, `api`, `pr` scripts there to fake answers)
 *   npm: exit code for any `npm ...` call
 * Every stub is written in both forms, with no platform check: Windows resolves the
 * `.exe` / `.cmd` one and never runs an extensionless file; POSIX resolves the sh one.
 */
export function makeBin({ gh = null, npm = null } = {}) {
  const dir = makeTmp("hyperion-bin-");
  if (gh === "fail") {
    writeFileSync(join(dir, "gh.exe"), "not an executable");
    writeScript(join(dir, "gh"), "#!/bin/sh\nexit 1\n");
  } else if (gh === "node") {
    linkSync(nodeBinary(), join(dir, "gh.exe"));
    writeScript(join(dir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  }
  if (npm !== null) {
    writeFileSync(join(dir, "npm.cmd"), `@exit /b ${npm}\r\n`);
    writeScript(join(dir, "npm"), `#!/bin/sh\nexit ${npm}\n`);
  }
  return dir;
}

function writeScript(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

let hooksDir = null;

/** git in a temp dir, isolated from the developer's system config, signing and hooks. */
export function git(cwd, args, { env = {} } = {}) {
  if (!hooksDir) hooksDir = makeTmp("hyperion-hooks-");
  const r = spawnSync(
    "git",
    [
      "-c", "user.name=Hyperion Test",
      "-c", "user.email=test@example.com",
      "-c", "commit.gpgsign=false",
      "-c", "tag.gpgsign=false",
      "-c", `core.hooksPath=${hooksDir}`,
      ...args,
    ],
    { cwd, encoding: "utf8", env: childEnv({ GIT_CONFIG_NOSYSTEM: "1", ...env }), windowsHide: true }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** `git init` + commit everything in `dir` on `main`; returns the HEAD sha. */
export function gitCommitAll(dir, message = "init") {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/**
 * Env that rewrites https://github.com/<owner>/<repo>.git (anonymous and/or with
 * one of `tokens` as x-access-token) to local repos under `remotesDir/<owner>/<repo>.git`.
 */
export function githubToLocalEnv(remotesDir, tokens = [], { anonymous = true } = {}) {
  const base = `${pathToFileURL(remotesDir).href}/`;
  const prefixes = [
    ...(anonymous ? ["https://github.com/"] : []),
    ...tokens.map((t) => `https://x-access-token:${t}@github.com/`),
  ];
  const env = { GIT_CONFIG_COUNT: String(prefixes.length) };
  prefixes.forEach((p, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `url.${base}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = p;
  });
  return env;
}
