import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./pipeline-plan.mjs", import.meta.url));
const env = { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() };
delete env.HYPERION_ROOT;
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;

const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

// origin/HEAD resolves on the first git probe, keeping detectDefaultBranch fast and offline.
const FAKE_GIT = {
  ".git/HEAD": "ref: refs/heads/main\n",
  ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/main\n",
  ".git/refs/heads/.keep": "",
  ".git/objects/.keep": "",
};

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-plan-"));
  roots.push(root);
  for (const [rel, content] of Object.entries({ ...FAKE_GIT, ...files })) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function plan(root) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe("pipeline-plan CLI", () => {
  it("prints warnings, planned writes with reasons, and skips — and writes nothing", () => {
    const root = makeRepo({
      ".github/workflows/ci.yml": "name: ci\n",
      ".github/workflows/hyperion-sync-cards.yml": "name: sync\n",
      "package.json": "{}",
    });
    const out = plan(root);
    assert.match(out, /Pipeline plan \(dry-run\)/);
    assert.match(out, /Policy: detect/);
    assert.match(out, /Stack: node-npm/);
    assert.match(out, /Product CI exists: true/);
    assert.match(out, /Legacy kit workflows found \(ci\.yml\)/);
    assert.match(out, /Would write:/);
    assert.match(out, /\+ \.github\/workflows\/hyperion-cards-pr-check\.yml\r?\n.*\(PR directional board guard/);
    assert.match(out, /\+ \.github\/workflows\/hyperion-security\.yml/);
    assert.doesNotMatch(out, /\+ \.github\/workflows\/hyperion-sync-cards\.yml/);
    assert.match(out, /Skipped:/);
    assert.match(out, /- \.github\/workflows\/hyperion-sync-cards\.yml already exists — not overwritten\./);
    assert.match(out, /- Product CI already exists/);
    assert.match(out, /Plan complete\. Apply with: npm run hyperion:pipeline-apply/);
    assert.deepEqual(fs.readdirSync(path.join(root, ".github/workflows")).sort(), ["ci.yml", "hyperion-sync-cards.yml"]);
  });

  it("ci.policy=skip has no files to write", () => {
    const root = makeRepo({ ".github/project.yml": "ci:\n  policy: skip\n" });
    const out = plan(root);
    assert.match(out, /Policy: skip/);
    assert.match(out, /\(no workflow files to write\)/);
    assert.match(out, /- All Hyperion workflow writes skipped \(ci\.policy=skip\)\./);
  });
});
