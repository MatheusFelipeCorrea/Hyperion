import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execSync } from "node:child_process";
import { isDefaultBranch, isLiveSyncAllowed } from "./watch.mjs";

const createdDirs = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-watch-"));
  createdDirs.push(dir);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "x\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "x"],
    { cwd: dir }
  );
  return dir;
}

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

test("isLiveSyncAllowed defaults to false, true only when CARDS_WATCH_LIVE=true", () => {
  delete process.env.CARDS_WATCH_LIVE;
  assert.equal(isLiveSyncAllowed(), false);

  process.env.CARDS_WATCH_LIVE = "true";
  try {
    assert.equal(isLiveSyncAllowed(), true);
  } finally {
    delete process.env.CARDS_WATCH_LIVE;
  }
});

test("isDefaultBranch returns true on main with no remote configured (literal fallback)", () => {
  const dir = makeRepo();
  delete process.env.CARDS_WATCH_ANY_BRANCH;
  assert.equal(isDefaultBranch(dir), true);
});

test("isDefaultBranch returns false on a feature branch when origin HEAD points elsewhere", () => {
  const dir = makeRepo();
  spawnSync("git", ["remote", "add", "origin", "https://example.invalid/repo.git"], { cwd: dir });
  spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: dir });
  spawnSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: dir });
  delete process.env.CARDS_WATCH_ANY_BRANCH;
  assert.equal(isDefaultBranch(dir), false);
});

test("isDefaultBranch fails CLOSED (false) when the branch can't be detected (detached HEAD)", () => {
  const dir = makeRepo();
  const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
  spawnSync("git", ["checkout", "-q", sha], { cwd: dir });
  delete process.env.CARDS_WATCH_ANY_BRANCH;
  assert.equal(isDefaultBranch(dir), false);
});

test("CARDS_WATCH_ANY_BRANCH=true bypasses branch detection entirely, even on a feature branch", () => {
  const dir = makeRepo();
  spawnSync("git", ["checkout", "-q", "-b", "some-other-branch"], { cwd: dir });
  process.env.CARDS_WATCH_ANY_BRANCH = "true";
  try {
    assert.equal(isDefaultBranch(dir), true);
  } finally {
    delete process.env.CARDS_WATCH_ANY_BRANCH;
  }
});
