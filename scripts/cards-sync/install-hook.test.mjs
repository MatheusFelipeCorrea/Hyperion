import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildPreCommitHookBody } from "./install-hook.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const installHookScript = join(__dirname, "install-hook.mjs");

const createdDirs = [];

function makeTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function initGitRepo(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"],
    { cwd: dir }
  );
}

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPreCommitHookBody uses nested kit paths", () => {
  const root = makeTemp("hyperion-hook-");
  mkdirSync(join(root, ".github"), { recursive: true });
  mkdirSync(join(root, "Hyperion", ".github", "cards"), { recursive: true });
  writeFileSync(
    join(root, ".github", "project.yml"),
    "kit:\n  root: Hyperion\n",
    "utf8"
  );

  const paths = resolveHyperionPaths(root);
  const body = buildPreCommitHookBody(paths);

  assert.ok(body.includes("Hyperion/scripts/cards-sync/validate.mjs"));
  assert.ok(body.includes("Hyperion/.github/cards") || body.includes("Hyperion/\\.github/cards"));
  assert.match(body, /hyperion-cards-validate/);
  assert.match(body, /hyperion-check-rules/);
});

test("buildPreCommitHookBody uses legacy root layout", () => {
  const root = makeTemp("hyperion-hook-");
  mkdirSync(join(root, ".github", "cards"), { recursive: true });

  const paths = resolveHyperionPaths(root);
  const body = buildPreCommitHookBody(paths);

  assert.match(body, /\.github\/cards/);
  assert.match(body, /scripts\/cards-sync\/validate\.mjs/);
  assert.doesNotMatch(body, /Hyperion\/scripts/);
});

test("importing the module does not install a hook (entrypoint guard)", () => {
  const root = makeTemp("hyperion-hook-guard-");
  initGitRepo(root);

  const importerPath = join(root, "importer.mjs");
  writeFileSync(
    importerPath,
    `import ${JSON.stringify(pathToFileURL(installHookScript).href)};\nconsole.log("import-ok");\n`,
    "utf8"
  );

  const r = spawnSync(process.execPath, [importerPath], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /import-ok/);
  assert.ok(
    !existsSync(join(root, ".git", "hooks", "pre-commit")),
    "hook should NOT be installed just from importing the module"
  );
});

test("running the script directly installs the hook at .git/hooks/pre-commit", () => {
  const root = makeTemp("hyperion-hook-run-");
  initGitRepo(root);

  const r = spawnSync(process.execPath, [installHookScript, "--yes"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /pre-commit hook installed/);
  assert.ok(existsSync(join(root, ".git", "hooks", "pre-commit")));
});

test("works inside a git worktree, where .git is a file, not a directory", () => {
  const root = makeTemp("hyperion-hook-wt-base-");
  initGitRepo(root);

  const worktreeDir = join(tmpdir(), `hyperion-hook-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const added = spawnSync("git", ["worktree", "add", "--detach", worktreeDir], { cwd: root, encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr || added.stdout);

  try {
    assert.ok(!existsSync(join(worktreeDir, ".git", "hooks")), ".git should be a file pointer here, not a directory with hooks/");

    const r = spawnSync(process.execPath, [installHookScript, "--yes"], { cwd: worktreeDir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /pre-commit hook installed/);
  } finally {
    spawnSync("git", ["worktree", "remove", worktreeDir, "--force"], { cwd: root });
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});
