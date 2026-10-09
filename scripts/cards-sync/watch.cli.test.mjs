import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDefaultBranch } from "./watch.mjs";
import { card, cleanEnv, cleanupTempDirs, makeTempDir, runNode, scriptPath, writeFile } from "./test-support/ci-fixture.mjs";

const watchScript = scriptPath("watch.mjs");
let exitPreload;
let childPreload;

before(() => {
  const dir = makeTempDir("hyperion-watch-preload-");
  // Watcher only: exit cleanly on request so V8 coverage is flushed (a kill would lose it).
  exitPreload = pathToFileURL(writeFile(dir, "exit-on-message.mjs", `process.on("message", (m) => { if (m === "exit") process.exit(0); });\n`)).href;
  // Grandchildren (via NODE_OPTIONS): record each validate/sync spawn; sync.mjs becomes a stub
  // whose exit code comes from WATCH_TEST_SYNC_EXITS (comma list, by invocation).
  childPreload = pathToFileURL(
    writeFile(
      dir,
      "record-child.mjs",
      `import { appendFileSync, readFileSync } from "node:fs";
const m = (process.argv[1] || "").replace(/\\\\/g, "/").match(/cards-sync\\/(sync|validate)\\.mjs$/);
if (m) {
  const e = process.env;
  appendFileSync(e.WATCH_TEST_LOG, JSON.stringify({ script: m[1], only: e.CARDS_SYNC_ONLY ?? null, dryRun: e.DRY_RUN ?? null, yes: e.CARDS_SYNC_YES ?? null, root: e.HYPERION_ROOT ?? null }) + "\\n");
  const delay = Number(e.WATCH_TEST_DELAY_MS || 0);
  if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  if (m[1] === "sync") {
    const n = readFileSync(e.WATCH_TEST_LOG, "utf8").split("\\n").filter((l) => l.includes('"script":"sync"')).length;
    process.exit(Number((e.WATCH_TEST_SYNC_EXITS || "").split(",")[n - 1] || 0));
  }
}
`
    )
  ).href;
});

after(cleanupTempDirs);

const READY = /Press Ctrl\+C to stop\./;
const DEADLINE_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (text, pattern) => (text.match(new RegExp(pattern.source, "g")) || []).length;

function startWatcher(cwd, env) {
  const log = join(cwd, ".watch-test.log");
  const child = spawn(process.execPath, ["--import", exitPreload, watchScript], {
    cwd,
    env: cleanEnv({ NODE_OPTIONS: `--import=${childPreload}`, WATCH_TEST_LOG: log, ...env }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let baseline = 0;
  child.stdout.setEncoding("utf8").on("data", (d) => (output += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (output += d));
  const closed = new Promise((resolve) => child.on("close", resolve));

  async function until(check, describe, timeoutMs = DEADLINE_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out waiting for ${describe}; output:\n${output}`);
      await sleep(50);
    }
  }

  const w = {
    /** Everything the watcher printed, including the warm-up pass. */
    get output() {
      return output;
    },
    /** Output printed after the watcher was confirmed live. */
    get recent() {
      return output.slice(baseline);
    },
    spawns: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    waitFor(pattern, n = 1) {
      return until(() => count(w.recent, pattern) >= n, `${pattern} x${n}`);
    },
    /**
     * Resolves once fs.watch demonstrably delivers events (recursive watch on Linux initializes
     * asynchronously after READY): rewrites a probe file under `cardsRel` until a change is
     * reported, waits for every triggered pass to finish, then starts `recent`/`spawns` afresh.
     */
    async ready(cardsRel) {
      await until(() => READY.test(output), String(READY));
      const probe = join(cwd, cardsRel, ".watch-probe.txt");
      const deadline = Date.now() + DEADLINE_MS;
      const detected = () => /\[cards-watch\] Change detected/.test(output);
      // Each attempt waits past the 600 ms debounce: rewriting sooner would keep resetting it.
      for (let i = 0; !detected(); i++) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`watcher never reported a change; output:\n${output}`);
        writeFileSync(probe, String(i));
        const retryAt = Date.now() + 2_000;
        while (!detected() && Date.now() < retryAt) await sleep(50);
      }
      // A pass ends with Done/Failed unless it was queued behind a running one; settled means every
      // reported change has ended and nothing new appeared for longer than the 600 ms debounce.
      const settled = () =>
        count(output, /\[cards-watch\] Change detected/) ===
        count(output, /\[cards-watch\] (Done|Failed)\b/) + count(output, /\[cards-watch\] Sync already running/);
      let quietSince = 0;
      let seen = -1;
      await until(() => {
        if (!settled() || output.length !== seen) {
          seen = output.length;
          quietSince = Date.now();
          return false;
        }
        return Date.now() - quietSince > 1_500;
      }, "the warm-up pass to settle");
      baseline = output.length;
      if (existsSync(log)) writeFileSync(log, "");
    },
    async stop() {
      if (child.exitCode === null && child.connected) child.send("exit");
      const timer = setTimeout(() => child.kill(), 10_000);
      const status = await closed;
      clearTimeout(timer);
      return status;
    },
  };
  return w;
}

/**
 * Runs `body` against a live watcher and stops it afterwards. The clean-exit assertion only runs
 * when the body succeeded, so a body failure is never masked by the exit-code check.
 */
async function withWatcher(cwd, env, cardsRel, body) {
  const w = startWatcher(cwd, env);
  let status;
  try {
    await w.ready(cardsRel);
    await body(w);
  } finally {
    status = await w.stop();
  }
  assert.equal(status, 0, w.output);
  return w;
}
const task = (id, extra = {}) => card({ id, type: "Task", ...extra });

test("isDefaultBranch fails closed when git cannot run in the directory", () => {
  const prev = process.env.CARDS_WATCH_ANY_BRANCH;
  delete process.env.CARDS_WATCH_ANY_BRANCH;
  try {
    assert.equal(isDefaultBranch(join(makeTempDir("hyperion-watch-nogit-"), "does-not-exist")), false);
  } finally {
    if (prev !== undefined) process.env.CARDS_WATCH_ANY_BRANCH = prev;
  }
});

test("exits with an error when the cards folder is missing", () => {
  const r = runNode(watchScript, [], { cwd: makeTempDir("hyperion-watch-empty-") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.github\/cards\/ not found/);
});

describe("watch.mjs watcher", { concurrency: 3 }, () => {
  test("off the default branch: validate only, queues changes that arrive mid-run, reports failures", async () => {
    const ws = makeTempDir("hyperion-watch-validate-");
    // Directories exist before the watcher starts, so no event depends on a new folder being picked up.
    writeFile(ws, ".github/cards/tasks/_orphan/.keep", "");
    const env = { GIT_DIR: join(ws, "no-such-git-dir"), WATCH_TEST_DELAY_MS: "1500" };
    const w = await withWatcher(ws, env, ".github/cards", async (w) => {
      assert.match(w.output, /Dry-run mode \(default\)/);
      writeFile(ws, ".github/cards/tasks/_orphan/T-1.md", task("T-1"));
      await w.waitFor(/Validating cards\.\.\./);
      writeFile(ws, ".github/cards/tasks/_orphan/T-2.md", task("T-2"));
      await w.waitFor(/Sync already running — queued for next pass\./);
      await w.waitFor(/Change detected: queued changes/);
      await w.waitFor(/Done \(validate only\)\./, 2);
      assert.match(w.recent, /Skipping forward sync — not on default branch/);

      writeFile(ws, ".github/cards/tasks/_orphan/BAD-1.md", task("BAD-1", { type: "Bogus" }));
      await w.waitFor(/Failed: validate\.mjs exited with code 1/);
    });
    assert.ok(w.spawns().length > 0);
    assert.ok(w.spawns().every((s) => s.script === "validate"), "never syncs off the default branch");
  });

  test("dry-run by default: incremental ids exclude samples/templates/non-cards; nested kit root is passed down", async () => {
    const ws = makeTempDir("hyperion-watch-nested-");
    const cards = "Hyperion/.github/cards/tasks";
    writeFile(ws, `${cards}/_orphan/.keep`, "");
    const w = await withWatcher(ws, { CARDS_WATCH_ANY_BRANCH: "true" }, "Hyperion/.github/cards", async (w) => {
      writeFile(ws, `${cards}/notes.txt`, "ignored");
      writeFile(ws, `${cards}/README.md`, "# readme");
      writeFile(ws, `${cards}/_orphan/T-9.template.md`, task("T-9"));
      writeFile(ws, `${cards}/_orphan/EXAMPLE-TASK-1.md`, task("EXAMPLE-TASK-1"));
      writeFile(ws, `${cards}/_orphan/T-1.md`, task("T-1"));
      await w.waitFor(/Done \(dry-run\)\./);
      assert.match(w.recent, /DRY RUN — no board will be written/);
    });
    const sync = w.spawns().find((s) => s.script === "sync");
    assert.deepEqual(sync, { script: "sync", only: "T-1", dryRun: "true", yes: null, root: "Hyperion" });
  });

  test("LIVE mode: full sync for non-card changes, incremental for cards, logs sync failures", async () => {
    const ws = makeTempDir("hyperion-watch-live-");
    writeFile(ws, ".github/cards/tasks/_orphan/T-1.md", task("T-1"));
    writeFile(ws, ".github/cards/config/.keep", "");
    const env = { CARDS_WATCH_ANY_BRANCH: "true", CARDS_WATCH_LIVE: "true", WATCH_TEST_SYNC_EXITS: "0,3" };
    const w = await withWatcher(ws, env, ".github/cards", async (w) => {
      assert.match(w.output, /LIVE mode — real board writes on every change/);
      writeFile(ws, ".github/cards/config/projects-map.json", "{}");
      await w.waitFor(/Syncing all cards \(LIVE\)\.\.\./);
      await w.waitFor(/\] Done\.\r?\n/);
      writeFile(ws, ".github/cards/tasks/_orphan/T-1.md", task("T-1", { status: "Done" }));
      await w.waitFor(/Incremental sync \(LIVE\): T-1/);
      await w.waitFor(/Failed: sync\.mjs exited with code 3/);
    });
    const syncs = w.spawns().filter((s) => s.script === "sync");
    assert.deepEqual(syncs, [
      { script: "sync", only: null, dryRun: null, yes: "true", root: null },
      { script: "sync", only: "T-1", dryRun: null, yes: "true", root: null },
    ]);
  });
});
