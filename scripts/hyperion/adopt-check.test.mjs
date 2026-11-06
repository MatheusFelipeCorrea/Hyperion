import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkNoLeakedMaintainerFiles, checkNoLeakedTemplates } from "./adopt-check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "adopt-check.mjs");
const createdDirs = [];

function makeAdopterRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-adopt-"));
  createdDirs.push(dir);
  return dir;
}

function makeFailCollector() {
  const failures = [];
  const fail = (where, why) => failures.push({ where, why });
  return { failures, fail };
}

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

test("checkNoLeakedMaintainerFiles passes when a file is absent", () => {
  const dir = makeAdopterRepo();
  const { failures, fail } = makeFailCollector();
  checkNoLeakedMaintainerFiles(dir, fail);
  assert.equal(failures.length, 0);
});

test("checkNoLeakedMaintainerFiles passes when the adopter replaced the content", () => {
  const dir = makeAdopterRepo();
  writeFileSync(join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Acme Corp\n");
  writeFileSync(join(dir, "SECURITY.md"), "# Security Policy\n\nEmail security@acme.example.\n");
  const { failures, fail } = makeFailCollector();
  checkNoLeakedMaintainerFiles(dir, fail);
  assert.equal(failures.length, 0);
});

test("checkNoLeakedMaintainerFiles catches Hyperion's own LICENSE copyright line", () => {
  const dir = makeAdopterRepo();
  writeFileSync(join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Hyperion Contributors\n");
  const { failures, fail } = makeFailCollector();
  checkNoLeakedMaintainerFiles(dir, fail);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].where, "LICENSE");
  assert.match(failures[0].why, /Hyperion Contributors/);
});

test("checkNoLeakedMaintainerFiles catches a leaked CODEOWNERS and FUNDING.yml", () => {
  const dir = makeAdopterRepo();
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github", "CODEOWNERS"), "*  @MatheusFelipeCorrea\n");
  writeFileSync(join(dir, ".github", "FUNDING.yml"), "github: MatheusFelipeCorrea\n");
  const { failures, fail } = makeFailCollector();
  checkNoLeakedMaintainerFiles(dir, fail);
  assert.equal(failures.length, 2);
  const where = failures.map((f) => f.where).sort();
  assert.deepEqual(where, [".github/CODEOWNERS", ".github/FUNDING.yml"]);
});

test("checkNoLeakedTemplates passes for a clean or absent .github/ISSUE_TEMPLATE/", () => {
  const dir = makeAdopterRepo();
  let { failures, fail } = makeFailCollector();
  checkNoLeakedTemplates(dir, fail);
  assert.equal(failures.length, 0);

  mkdirSync(join(dir, ".github", "ISSUE_TEMPLATE"), { recursive: true });
  writeFileSync(join(dir, ".github", "ISSUE_TEMPLATE", "bug.md"), "---\nname: Bug\n---\nDescribe the bug.\n");
  ({ failures, fail } = makeFailCollector());
  checkNoLeakedTemplates(dir, fail);
  assert.equal(failures.length, 0);
});

test("checkNoLeakedTemplates catches a leaked issue template and PR template", () => {
  const dir = makeAdopterRepo();
  mkdirSync(join(dir, ".github", "ISSUE_TEMPLATE"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "ISSUE_TEMPLATE", "question.md"),
    "Open a Question issue on MatheusFelipeCorrea/Hyperion.\n"
  );
  writeFileSync(join(dir, ".github", "PULL_REQUEST_TEMPLATE.md"), "Thanks for contributing to Hyperion Contributors!\n");
  const { failures, fail } = makeFailCollector();
  checkNoLeakedTemplates(dir, fail);
  assert.equal(failures.length, 2);
});

test("running as a script exits 0 on a clean adopter repo and 1 on a leaked one", () => {
  const dir = makeAdopterRepo();
  const clean = spawnSync(process.execPath, [scriptPath, "--root", dir], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /adopt-check OK/);

  writeFileSync(join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Hyperion Contributors\n");
  const dirty = spawnSync(process.execPath, [scriptPath, "--root", dir], { encoding: "utf8" });
  assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
  assert.match(dirty.stdout + dirty.stderr, /FAILED/);
});
