/**
 * Test support for the cards-sync CI entry scripts (ci-sync, pr-board-guard,
 * report-pr-guard-check, watch, history, metrics, notify): throwaway git
 * workspaces, stub child scripts and a scrubbed env so runs are offline and
 * independent of the host repo / CI variables.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const cardsSyncDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const scriptPath = (name) => join(cardsSyncDir, name);

const created = [];

export function makeTempDir(prefix = "hyperion-ci-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function writeFile(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

export function readFile(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

export function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function initRepo(dir, branch = "main") {
  git(dir, "init", "-q", "-b", branch);
  // Scripts under test call git without our -c flags; pin line endings for them too (no extra spawn).
  appendFileSync(join(dir, ".git", "config"), "[core]\n\tautocrlf = false\n");
  return dir;
}

export function commitAll(dir, message = "c") {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** Copy a prepared template workspace (including .git) into a fresh temp dir. */
export function cloneWorkspace(template, prefix = "hyperion-ci-ws-") {
  const dir = makeTempDir(prefix);
  cpSync(template, dir, { recursive: true });
  return dir;
}

export function card({ id, status = "Backlog", type = "Story", priority = "Medium", parent = null, sprint = null }) {
  return [
    "---",
    `card_id: ${id}`,
    `title: "Card ${id}"`,
    `status: ${status}`,
    `type: ${type}`,
    `priority: ${priority}`,
    `sprint: ${sprint ?? "null"}`,
    "story_points: 3",
    `parent: ${parent ?? "null"}`,
    "categories: []",
    "---",
    "",
    `# Card ${id}`,
    "",
  ].join("\n");
}

const SCRUB = /^(GITHUB_|CARDS_|CI_MERGE_REQUEST_|SLACK_|DISCORD_|HYPERION_)|^(DRY_RUN|GH_TOKEN|GIT_DIR|PROJECT_SYNC_TOKEN|NODE_OPTIONS)$/i;

/** process.env minus anything that would steer the scripts, plus the fixed test identity. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUB.test(k)) env[k] = v;
  Object.assign(env, {
    GITHUB_REPOSITORY: "acme/app",
    PROJECT_SYNC_TOKEN: "test-token",
    HYPERION_NO_DOTENV: "1",
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export function runNode(script, args = [], { cwd, env = cleanEnv(), execArgv = [], input } = {}) {
  const r = spawnSync(process.execPath, [...execArgv, script, ...args], { cwd, env, encoding: "utf8", input, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", output: `${r.stdout || ""}${r.stderr || ""}` };
}

/** Async runNode so independent scenarios can run concurrently (process spawns dominate on Windows). */
export function runNodeAsync(script, args = [], { cwd, env = cleanEnv(), execArgv = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, script, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, output: stdout + stderr });
    });
  });
}

/**
 * Generic stand-in for a child script (validate.mjs, sync.mjs, pr-board-guard.mjs).
 * Reads `.stub/plan.json` → `{ "<script>.mjs": [{ exit, write: { rel: content } }, ...] }`;
 * the Nth invocation of a script uses the Nth step (missing → exit 0, no writes).
 */
const STUB_SOURCE = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const name = basename(process.argv[1]);
const dir = join(process.cwd(), ".stub");
mkdirSync(dir, { recursive: true });
const read = (f) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : {});
const plan = read("plan.json");
const state = read("state.json");
const n = (state[name] = (state[name] || 0) + 1);
writeFileSync(join(dir, "state.json"), JSON.stringify(state));
const step = (plan[name] || [])[n - 1] || {};
const e = process.env;
console.log("STUB " + name + "#" + n + " args=[" + process.argv.slice(2).join(" ") + "] DRY_RUN=" + (e.DRY_RUN || "") +
  " BASE=" + (e.CARDS_GUARD_BASE_REF || "") + " GITHUB_BASE_SHA=" + (e.GITHUB_BASE_SHA || "") + " STRICT=" + (e.CARDS_CI_STRICT_GIT || ""));
for (const [rel, content] of Object.entries(step.write || {})) {
  mkdirSync(dirname(join(process.cwd(), rel)), { recursive: true });
  writeFileSync(join(process.cwd(), rel), content);
}
process.exit(step.exit ?? 0);
`;

export function installStubs(root, names, kitRootRel = "") {
  for (const name of names) writeFile(root, join(kitRootRel, "scripts", "cards-sync", name), STUB_SOURCE);
  // Keep stubs + their bookkeeping out of `git status` noise.
  writeFile(root, ".gitignore", ".stub/\nscripts/\n");
}

export function setStubPlan(root, plan) {
  writeFile(root, join(".stub", "plan.json"), JSON.stringify(plan));
}

/** Preload that makes console.log throw once a line contains $HYPERION_TEST_THROW_ON_LOG — drives `main().catch`. */
export function throwOnLogPreload(dir) {
  const file = writeFile(
    dir,
    "throw-on-log.mjs",
    `const needle = process.env.HYPERION_TEST_THROW_ON_LOG;
const original = console.log;
console.log = (...args) => {
  if (needle && args.join(" ").includes(needle)) throw new Error("injected failure");
  return original(...args);
};
`
  );
  return pathToFileURL(file).href;
}
