import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  parseArgs,
  inspectProcess,
  writePending,
  clearPending,
  runGuard,
} from "./process-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "process-guard.mjs");
const created = [];

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function initGit(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "checkout", "-q", "-b", "feat/PROJ-S1-login"], {
    cwd: dir,
  });
  writeFileSync(join(dir, "README.md"), "x\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir });
}

after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

test("parseArgs reads --check and --card", () => {
  assert.deepEqual(parseArgs(["--check", "review", "--card", "APP-1"]).check, "review");
  assert.equal(parseArgs(["--check", "review", "--card", "APP-1"]).card, "APP-1");
  assert.equal(parseArgs(["implement", "APP-9"]).check, "implement");
  assert.equal(parseArgs(["implement", "APP-9"]).card, "APP-9");
});

test("implement without spec marks pending; review blocks; spec clears", () => {
  const root = temp("hyperion-pg-");
  initGit(root);
  mkdirSync(join(root, ".github", "cards", "stories"), { recursive: true });
  writeFileSync(join(root, ".github", "cards", "stories", "PROJ-S1.md"), "---\ncard_id: PROJ-S1\n---\n", "utf8");

  assert.equal(runGuard({ check: "implement", card: "PROJ-S1", root }), 0);
  assert.equal(runGuard({ check: "review", card: "PROJ-S1", root }), 2);

  const specDir = join(root, ".github", "plans", "specs", "PROJ-S1");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "spec.md"), "## Scenario: login\n\nGiven a user\nWhen they sign in\nThen ok\n", "utf8");

  const info = inspectProcess(root, "PROJ-S1");
  assert.equal(info.hasSpec, true);
  assert.equal(info.pending, "");
  assert.equal(info.pendingCleared, true);
  assert.equal(runGuard({ check: "review", card: "PROJ-S1", root }), 0);
});

test("smoke blocked while pending; --clear unlocks", () => {
  const root = temp("hyperion-pg-clear-");
  initGit(root);
  writePending(root, "X-1");
  assert.equal(runGuard({ check: "smoke", card: "X-1", root }), 2);
  assert.equal(runGuard({ clear: true, root }), 0);
  assert.equal(runGuard({ check: "smoke", card: "X-1", root }), 0);
  clearPending(root);
});

test("HYPERION_SKIP_PROCESS_GUARD bypasses block", () => {
  const root = temp("hyperion-pg-skip-");
  initGit(root);
  writePending(root, "Y-1");
  const prev = process.env.HYPERION_SKIP_PROCESS_GUARD;
  process.env.HYPERION_SKIP_PROCESS_GUARD = "1";
  try {
    assert.equal(runGuard({ check: "review", card: "Y-1", root }), 0);
  } finally {
    if (prev === undefined) delete process.env.HYPERION_SKIP_PROCESS_GUARD;
    else process.env.HYPERION_SKIP_PROCESS_GUARD = prev;
  }
});

test("CLI --status exits 0", () => {
  const root = temp("hyperion-pg-cli-");
  initGit(root);
  const r = spawnSync(process.execPath, [script, "--status", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pending:/);
});
