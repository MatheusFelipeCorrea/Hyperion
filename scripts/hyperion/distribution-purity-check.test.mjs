import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkNoProjectNumber,
  checkSyncCardsNoPushTrigger,
  checkNoInternalOnlyWorkflows,
  checkNotManagedFiles,
  checkNoRealCards,
  checkNoLeakedPlans,
  checkNoLeakedPaths,
  detectKit,
  excludePattern,
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
  const fail = (where, why, fix = null) => failures.push({ where, why, fix });
  return { failures, fail };
}

function run(dir, args = [], env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}

function tracked(dir, pathspec = ".github") {
  return spawnSync("git", ["-c", "core.quotePath=false", "ls-files", "--", pathspec], { cwd: dir, encoding: "utf8" }).stdout;
}

/** A kit-looking checkout with one bound board, a real card and a leaked plan. */
function makeDirtyKitRepo(cardNames = ["TEST-001.md"]) {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "cards", "config"), { recursive: true });
  mkdirSync(join(dir, ".github", "cards", "stories"), { recursive: true });
  mkdirSync(join(dir, ".github", "plans"), { recursive: true });
  mkdirSync(join(dir, "scripts", "hyperion"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "hyperion", repository: { type: "git", url: "https://github.com/MatheusFelipeCorrea/Hyperion.git" } })
  );
  writeFileSync(
    join(dir, ".github", "cards", "config", "projects-map.json"),
    JSON.stringify({ default: { projectNumber: 99 }, repositories: {} })
  );
  for (const name of cardNames) writeFileSync(join(dir, ".github", "cards", "stories", name), `# ${name}\n`);
  writeFileSync(join(dir, ".github", "plans", "notes.md"), "notes\n");
  writeFileSync(join(dir, "scripts", "hyperion", "upgrade-lib.mjs"), 'export const MANAGED_FILES = [".github/commands.yml"];\n');
  commitAll(dir);
  return dir;
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

test("checkNoInternalOnlyWorkflows ignores other triggers, fails on push to internal", () => {
  const dir = makeRepo();
  const wfDir = join(dir, ".github", "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "internal-sync.yml"), "on:\n  push:\n    branches: [main]\njobs: {}\n");
  writeFileSync(join(wfDir, "hyperion-validate.yml"), "on:\n  pull_request:\n    branches: [main, dev, qa]\njobs: {}\n");

  let { failures, fail } = makeFailCollector();
  checkNoInternalOnlyWorkflows(dir, fail);
  assert.equal(failures.length, 0);

  writeFileSync(join(wfDir, "internal-cards-sync.yml"), "on:\n  push:\n    branches:\n      - internal\njobs: {}\n");
  ({ failures, fail } = makeFailCollector());
  checkNoInternalOnlyWorkflows(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].where, /internal-cards-sync\.yml/);
});

test("checkNoInternalOnlyWorkflows fails on internal-*.yml by name, except internal-sync.yml", () => {
  const dir = makeRepo();
  const wfDir = join(dir, ".github", "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "internal-sync.yml"), "on:\n  push:\n    branches: [main]\njobs: {}\n");
  writeFileSync(join(wfDir, "internal-report.yaml"), "on:\n  workflow_dispatch:\njobs: {}\n");
  writeFileSync(join(wfDir, "internal-broken.yml"), "on: [unclosed\n");

  const { failures, fail } = makeFailCollector();
  checkNoInternalOnlyWorkflows(dir, fail);
  assert.deepEqual(
    failures.map((f) => f.where).sort(),
    [".github/workflows/internal-broken.yml", ".github/workflows/internal-report.yaml"],
  );
});

test("checkNotManagedFiles passes normally, fails if CODEOWNERS/FUNDING.yml/dependabot.yml get listed", async () => {
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

  writeFileSync(libPath, 'export const MANAGED_FILES = [".github/commands.yml", ".github/dependabot.yml"];\n');
  ({ failures, fail } = makeFailCollector());
  await checkNotManagedFiles(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].why, /dependabot\.yml/);
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

  // Built from parts at runtime, not a literal in this file — otherwise this
  // very test fixture would trip the check when it scans its own source.
  const examplePath = ["C:", "Users", "someone", "secret.txt"].join("\\\\");
  writeFileSync(join(dir, "leak.mjs"), `const p = "${examplePath}";\n`);
  commitAll(dir);
  ({ failures, fail } = makeFailCollector());
  checkNoLeakedPaths(dir, fail);
  assert.equal(failures.length, 1);
  assert.match(failures[0].where, /leak\.mjs/);
});

test("checkNoRealCards and checkNoLeakedPlans report non-ASCII file names verbatim", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "cards", "stories"), { recursive: true });
  mkdirSync(join(dir, ".github", "plans"), { recursive: true });
  writeFileSync(join(dir, ".github", "cards", "stories", "ação-001.md"), "# card\n");
  writeFileSync(join(dir, ".github", "plans", "revisão.md"), "notes\n");
  commitAll(dir);

  let { failures, fail } = makeFailCollector();
  checkNoRealCards(dir, fail);
  assert.deepEqual(failures.map((f) => f.where), [".github/cards/stories/ação-001.md"]);

  ({ failures, fail } = makeFailCollector());
  checkNoLeakedPlans(dir, fail);
  assert.deepEqual(failures.map((f) => f.where), [".github/plans/revisão.md"]);
});

test("checkSyncCardsNoPushTrigger suggests upstream/dev in a fork with an upstream remote", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "hyperion-sync-cards.yml"), "on:\n  push:\n    branches: [main]\n");

  let { failures, fail } = makeFailCollector();
  checkSyncCardsNoPushTrigger(dir, fail);
  assert.match(failures[0].fix.hint, /--source=origin\/dev /);

  spawnSync("git", ["remote", "add", "upstream", "https://example.invalid/kit.git"], { cwd: dir });
  ({ failures, fail } = makeFailCollector());
  checkSyncCardsNoPushTrigger(dir, fail);
  assert.match(failures[0].fix.hint, /--source=upstream\/dev /);
});

test("detectKit recognises the kit (or a fork) and nothing else", () => {
  const dir = makeRepo();
  assert.equal(detectKit(dir).isKit, false, "no package.json");

  const kitPkg = { name: "hyperion", repository: { type: "git", url: "https://github.com/MatheusFelipeCorrea/Hyperion.git" } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(kitPkg));
  assert.equal(detectKit(dir).isKit, true);

  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...kitPkg, repository: "git@github.com:MatheusFelipeCorrea/Hyperion.git" }));
  assert.equal(detectKit(dir).isKit, true, "string repository form");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...kitPkg, name: "acme-app" }));
  assert.equal(detectKit(dir).isKit, false, "product package.json");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...kitPkg, repository: "https://github.com/acme/Hyperion.git" }));
  assert.equal(detectKit(dir).isKit, false, "another repo named hyperion");

  writeFileSync(join(dir, "package.json"), JSON.stringify(kitPkg));
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github", "hyperion-kit.json"), "{}\n");
  assert.equal(detectKit(dir).isKit, false, "upgraded product");
});

test("excludePattern anchors the path and escapes glob metacharacters, ! and #", () => {
  assert.equal(excludePattern(".github/cards/a.md"), "/.github/cards/a.md");
  assert.equal(excludePattern(".github/cards/a*b?.md"), "/.github/cards/a\\*b\\?.md");
  assert.equal(excludePattern(".github/cards/[x] !#1.md"), "/.github/cards/\\[x\\] \\!\\#1.md");
  assert.equal(excludePattern("dir/back\\slash.md"), "/dir/back\\\\slash.md");
  assert.equal(excludePattern("dir/trailing  "), "/dir/trailing\\ \\ ");
});

test("outside the kit the script checks nothing and --fix --yes changes nothing", () => {
  const dir = makeDirtyKitRepo();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme-app", private: true }));
  commitAll(dir);

  const plain = run(dir);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /not the Hyperion kit repository/);

  const fix = run(dir, ["--fix", "--yes"]);
  assert.equal(fix.status, 0, fix.stdout + fix.stderr);
  assert.match(tracked(dir), /TEST-001\.md/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".github", "cards", "config", "projects-map.json"), "utf8")).default.projectNumber, 99);
});

test("a failing run points at --fix, with plain output outside GitHub Actions", () => {
  const dir = makeDirtyKitRepo();

  const dirty = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /-- --fix/);
  assert.doesNotMatch(dirty.stderr, /::error/, "plain output outside GitHub Actions");

  const inActions = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true" } });
  assert.match(inActions.stderr, /::error title=Binding to the Hyperion repo,file=\.github\/cards\/config\/projects-map\.json::.*PROJECT_NUMBER in your \.env/);
});

test("--fix without --yes prints the plan and changes nothing", () => {
  const dir = makeDirtyKitRepo();
  const mapPath = join(dir, ".github", "cards", "config", "projects-map.json");

  const preview = run(dir, ["--fix"]);
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /--fix plan \(nothing changed yet\)/);
  assert.match(preview.stdout, /default=#99/);
  assert.match(preview.stdout, /untrack .*TEST-001\.md/);
  assert.match(preview.stdout, /--fix --yes/);
  assert.equal(JSON.parse(readFileSync(mapPath, "utf8")).default.projectNumber, 99);
  assert.match(tracked(dir), /TEST-001\.md/);
  assert.ok(!existsSync(join(dir, ".git", "hyperion-backup")));
});

test("--fix --yes backs files up, untracks them with escaped excludes, and the backup survives git clean -X", () => {
  const cards = ["TEST-001.md", "ação-002.md", "[draft] #3!.md"];
  const dir = makeDirtyKitRepo(cards);
  const mapPath = join(dir, ".github", "cards", "config", "projects-map.json");
  rmSync(join(dir, ".git", "info"), { recursive: true, force: true });

  const fixed = run(dir, ["--fix", "--yes"]);
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.match(fixed.stdout, /PROJECT_NUMBER=<n> in \.env/);
  assert.equal(JSON.parse(readFileSync(mapPath, "utf8")).default.projectNumber, null);

  const stamps = readdirSync(join(dir, ".git", "hyperion-backup"));
  assert.equal(stamps.length, 1);
  const backupDir = join(dir, ".git", "hyperion-backup", stamps[0]);
  assert.ok(fixed.stdout.includes(`Backup of every untracked file: ${backupDir}`), fixed.stdout);
  assert.match(fixed.stdout, /git clean -X/);
  assert.match(fixed.stdout, /Copy-Item -Recurse -Force/);

  for (const name of cards) {
    assert.ok(existsSync(join(dir, ".github", "cards", "stories", name)), `${name} stays on disk`);
    assert.equal(readFileSync(join(backupDir, ".github", "cards", "stories", name), "utf8"), `# ${name}\n`);
  }
  assert.ok(existsSync(join(backupDir, ".github", "plans", "notes.md")));

  const stillTracked = tracked(dir);
  for (const name of [...cards, "notes.md"]) assert.ok(!stillTracked.includes(name), `${name} untracked`);
  const status = spawnSync("git", ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }).stdout;
  for (const name of cards) assert.ok(!status.includes(`?? .github/cards/stories/${name}`), `${name} excluded, so \`git add -A\` won't bring it back`);
  assert.ok(existsSync(join(dir, ".git", "info", "exclude")), ".git/info/ recreated");

  spawnSync("git", ["clean", "-fdXq"], { cwd: dir });
  assert.ok(!existsSync(join(dir, ".github", "cards", "stories", "TEST-001.md")), "git clean -X deletes excluded working copies");
  assert.equal(readFileSync(join(backupDir, ".github", "cards", "stories", "TEST-001.md"), "utf8"), "# TEST-001.md\n");
});

test("--fix refuses on the internal branch", () => {
  const dir = makeDirtyKitRepo();
  spawnSync("git", ["checkout", "-q", "-b", "internal"], { cwd: dir });

  const refused = run(dir, ["--fix", "--yes"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refused on branch `internal`/);
  assert.match(tracked(dir), /TEST-001\.md/);
  assert.ok(!existsSync(join(dir, ".git", "hyperion-backup")));
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

  const clean = run(dir, ["--assume-kit"]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /distribution-purity-check OK/);

  writeFileSync(
    join(dir, ".github", "cards", "config", "projects-map.json"),
    JSON.stringify({ default: { projectNumber: 99 }, repositories: {} })
  );
  commitAll(dir);
  const dirty = run(dir, ["--assume-kit"]);
  assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
  assert.match(dirty.stdout + dirty.stderr, /FAILED/);
});
