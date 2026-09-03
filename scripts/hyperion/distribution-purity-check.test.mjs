import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkNoProjectNumber,
  checkSyncCardsNoPushTrigger,
  checkNotManagedFiles,
  checkNoRealCards,
  checkNoLeakedPlans,
  checkNoLeakedPaths,
} from "./distribution-purity-check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "distribution-purity-check.mjs");
const createdDirs = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-purity-"));
  createdDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function commitAll(dir) {
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "x"],
    { cwd: dir }
  );
}

function makeFailCollector() {
  const failures = [];
  const fail = (where, why) => failures.push({ where, why });
  return { failures, fail };
}

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

test("checkNoProjectNumber passes when null, fails when set", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "cards", "config"), { recursive: true });
  const cfgPath = join(dir, ".github", "cards", "config", "projects-map.json");

  writeFileSync(cfgPath, JSON.stringify({ default: { projectNumber: null }, repositories: {} }));
  let { failures, fail } = makeFailCollector();
  checkNoProjectNumber(dir, fail);
  assert.equal(failures.length, 0);

  writeFileSync(cfgPath, JSON.stringify({ default: { projectNumber: 25 }, repositories: {} }));
  ({ failures, fail } = makeFailCollector());
  checkNoProjectNumber(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].why, /#25/);
});

test("checkNoProjectNumber also catches a leak under repositories.<slug>", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "cards", "config"), { recursive: true });
  const cfgPath = join(dir, ".github", "cards", "config", "projects-map.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({ default: { projectNumber: null }, repositories: { "acme/app": { projectNumber: 7 } } })
  );
  const { failures, fail } = makeFailCollector();
  checkNoProjectNumber(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].where, /projects-map\.json/);
});

test("checkSyncCardsNoPushTrigger passes on dispatch-only, fails with a push trigger", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  const wfPath = join(dir, ".github", "workflows", "hyperion-sync-cards.yml");

  writeFileSync(wfPath, "on:\n  workflow_dispatch:\n\njobs:\n  sync:\n    runs-on: ubuntu-latest\n");
  let { failures, fail } = makeFailCollector();
  checkSyncCardsNoPushTrigger(dir, fail);
  assert.equal(failures.length, 0);

  writeFileSync(wfPath, "on:\n  workflow_dispatch:\n  push:\n    branches: [main]\n\njobs:\n  sync:\n    runs-on: ubuntu-latest\n");
  ({ failures, fail } = makeFailCollector());
  checkSyncCardsNoPushTrigger(dir, fail);
  assert.equal(failures.length, 1);
});

test("checkNotManagedFiles passes normally, fails if CODEOWNERS/FUNDING.yml get listed", async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "scripts", "hyperion"), { recursive: true });
  const libPath = join(dir, "scripts", "hyperion", "upgrade-lib.mjs");

  writeFileSync(libPath, 'export const MANAGED_FILES = [".github/commands.yml"];\n');
  let { failures, fail } = makeFailCollector();
  await checkNotManagedFiles(dir, fail);
  assert.equal(failures.length, 0);

  writeFileSync(libPath, 'export const MANAGED_FILES = [".github/commands.yml", ".github/FUNDING.yml"];\n');
  ({ failures, fail } = makeFailCollector());
  await checkNotManagedFiles(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].why, /FUNDING\.yml/);
});

test("checkNoRealCards passes for template/_examples, fails for a real card", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "cards", "_examples", "epics"), { recursive: true });
  mkdirSync(join(dir, ".github", "cards", "features"), { recursive: true });
  writeFileSync(join(dir, ".github", "cards", "CARD.template.md"), "# template\n");
  writeFileSync(join(dir, ".github", "cards", "_examples", "epics", "EXAMPLE-EPIC-001.md"), "# example\n");
  commitAll(dir);

  let { failures, fail } = makeFailCollector();
  checkNoRealCards(dir, fail);
  assert.equal(failures.length, 0);

  writeFileSync(join(dir, ".github", "cards", "features", "REAL-001.md"), "# real backlog card\n");
  commitAll(dir);
  ({ failures, fail } = makeFailCollector());
  checkNoRealCards(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].where, /REAL-001\.md/);
});

test("checkNoLeakedPlans passes for .gitkeep-only, fails for a tracked doc", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "plans", "implementations"), { recursive: true });
  writeFileSync(join(dir, ".github", "plans", "implementations", ".gitkeep"), "");
  commitAll(dir);

  let { failures, fail } = makeFailCollector();
  checkNoLeakedPlans(dir, fail);
  assert.equal(failures.length, 0);

  writeFileSync(join(dir, ".github", "plans", "notes.md"), "internal notes\n");
  commitAll(dir);
  ({ failures, fail } = makeFailCollector());
  checkNoLeakedPlans(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].where, /notes\.md/);
});

test("checkNoLeakedPaths passes clean, fails on a committed absolute personal path", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "clean.mjs"), 'export const x = "relative/path.txt";\n');
  commitAll(dir);

  let { failures, fail } = makeFailCollector();
  checkNoLeakedPaths(dir, fail);
  assert.equal(failures.length, 0);

  writeFileSync(join(dir, "leak.mjs"), 'const p = "C:\\\\Users\\\\someone\\\\secret.txt";\n');
  commitAll(dir);
  ({ failures, fail } = makeFailCollector());
  checkNoLeakedPaths(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].where, /leak\.mjs/);
});

test("running as a script exits 0 on a clean repo and 1 on a dirty one", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "cards", "config"), { recursive: true });
  mkdirSync(join(dir, "scripts", "hyperion"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "cards", "config", "projects-map.json"),
    JSON.stringify({ default: { projectNumber: null }, repositories: {} })
  );
  writeFileSync(
    join(dir, "scripts", "hyperion", "upgrade-lib.mjs"),
    'export const MANAGED_FILES = [".github/commands.yml"];\n'
  );
  commitAll(dir);

  const clean = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /distribution-purity-check OK/);

  writeFileSync(
    join(dir, ".github", "cards", "config", "projects-map.json"),
    JSON.stringify({ default: { projectNumber: 99 }, repositories: {} })
  );
  commitAll(dir);
  const dirty = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: "utf8" });
  assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
  assert.match(dirty.stdout + dirty.stderr, /FAILED/);
});
