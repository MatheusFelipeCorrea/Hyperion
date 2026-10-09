import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

function startWatcher(cwd, env) {
  const log = join(cwd, ".watch-test.log");
  const child = spawn(process.execPath, ["--import", exitPreload, watchScript], {
    cwd,
    env: cleanEnv({ NODE_OPTIONS: `--import=${childPreload}`, WATCH_TEST_LOG: log, ...env }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (d) => (output += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (output += d));
  const closed = new Promise((resolve) => child.on("close", resolve));

  return {
    get output() {
      return output;
    },
    spawns: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    async waitFor(pattern, count = 1, timeoutMs = 20_000) {
      const re = new RegExp(pattern.source, "g");
      const deadline = Date.now() + timeoutMs;
      while ((output.match(re) || []).length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern} x${count}; output:\n${output}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async stop() {
      if (child.exitCode === null && child.connected) child.send("exit");
      const timer = setTimeout(() => child.kill(), 10_000);
      const status = await closed;
      clearTimeout(timer);
      return status;
    },
  };
}

const READY = /Press Ctrl\+C to stop\./;
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
    writeFile(ws, ".github/cards/tasks/.keep", "");
    const w = startWatcher(ws, { GIT_DIR: join(ws, "no-such-git-dir"), WATCH_TEST_DELAY_MS: "1500" });
    try {
      await w.waitFor(READY);
      assert.match(w.output, /Dry-run mode \(default\)/);
      writeFile(ws, ".github/cards/tasks/_orphan/T-1.md", task("T-1"));
      await w.waitFor(/Validating cards\.\.\./);
      writeFile(ws, ".github/cards/tasks/_orphan/T-2.md", task("T-2"));
      await w.waitFor(/Sync already running — queued for next pass\./);
      await w.waitFor(/Change detected: queued changes/);
      await w.waitFor(/Done \(validate only\)\./, 2);
      assert.match(w.output, /Skipping forward sync — not on default branch/);

      writeFile(ws, ".github/cards/tasks/_orphan/BAD-1.md", task("BAD-1", { type: "Bogus" }));
      await w.waitFor(/Failed: validate\.mjs exited with code 1/);
    } finally {
      assert.equal(await w.stop(), 0, w.output);
    }
    assert.ok(w.spawns().every((s) => s.script === "validate"), "never syncs off the default branch");
  });

  test("dry-run by default: incremental ids exclude samples/templates/non-cards; nested kit root is passed down", async () => {
    const ws = makeTempDir("hyperion-watch-nested-");
    writeFile(ws, "Hyperion/.github/cards/tasks/.keep", "");
    const w = startWatcher(ws, { CARDS_WATCH_ANY_BRANCH: "true" });
    try {
      await w.waitFor(READY);
      const cards = "Hyperion/.github/cards/tasks";
      writeFile(ws, `${cards}/notes.txt`, "ignored");
      writeFile(ws, `${cards}/README.md`, "# readme");
      writeFile(ws, `${cards}/_orphan/T-9.template.md`, task("T-9"));
      writeFile(ws, `${cards}/_orphan/EXAMPLE-TASK-1.md`, task("EXAMPLE-TASK-1"));
      writeFile(ws, `${cards}/_orphan/T-1.md`, task("T-1"));
      await w.waitFor(/Done \(dry-run\)\./);
      assert.match(w.output, /DRY RUN — no board will be written/);
    } finally {
      assert.equal(await w.stop(), 0, w.output);
    }
    const sync = w.spawns().find((s) => s.script === "sync");
    assert.deepEqual(sync, { script: "sync", only: "T-1", dryRun: "true", yes: null, root: "Hyperion" });
  });

  test("LIVE mode: full sync for non-card changes, incremental for cards, logs sync failures", async () => {
    const ws = makeTempDir("hyperion-watch-live-");
    writeFile(ws, ".github/cards/tasks/_orphan/T-1.md", task("T-1"));
    const w = startWatcher(ws, { CARDS_WATCH_ANY_BRANCH: "true", CARDS_WATCH_LIVE: "true", WATCH_TEST_SYNC_EXITS: "0,3" });
    try {
      await w.waitFor(READY);
      assert.match(w.output, /LIVE mode — real board writes on every change/);
      writeFile(ws, ".github/cards/config/projects-map.json", "{}");
      await w.waitFor(/Syncing all cards \(LIVE\)\.\.\./);
      await w.waitFor(/\] Done\.\n/);
      writeFile(ws, ".github/cards/tasks/_orphan/T-1.md", task("T-1", { status: "Done" }));
      await w.waitFor(/Incremental sync \(LIVE\): T-1/);
      await w.waitFor(/Failed: sync\.mjs exited with code 3/);
    } finally {
      assert.equal(await w.stop(), 0, w.output);
    }
    const syncs = w.spawns().filter((s) => s.script === "sync");
    assert.deepEqual(syncs, [
      { script: "sync", only: null, dryRun: null, yes: "true", root: null },
      { script: "sync", only: "T-1", dryRun: null, yes: "true", root: null },
    ]);
  });
});
