import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./pipeline-detect.mjs", import.meta.url));
const env = { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() };
delete env.HYPERION_ROOT;
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;

const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-detect-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function detect(root) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe("pipeline-detect CLI", () => {
  it("reports product, hyperion, legacy and external CI plus a suggested ci block", () => {
    const root = makeRepo({
      ".github/workflows/build.yml": "name: build\n",
      ".github/workflows/hyperion-sync-cards.yml": "name: sync\n",
      ".github/workflows/sync-cards.yml": "name: legacy\n",
      Jenkinsfile: "pipeline {}\n",
      "pyproject.toml": "[project]\nname = 'x'\n",
    });
    const out = detect(root);
    assert.match(out, /Pipeline detection/);
    assert.match(out, /Provider: jenkins/);
    assert.match(out, /Stack: python/);
    assert.match(out, /Policy: detect/);
    assert.match(out, /Product CI present: yes/);
    assert.match(out, /Product workflows: build\.yml/);
    assert.match(out, /Hyperion workflows: hyperion-sync-cards\.yml/);
    assert.match(out, /Legacy \(migrate\): sync-cards\.yml/);
    assert.match(out, /External CI: jenkins \(Jenkinsfile\)/);
    assert.match(out, /Suggested project\.yml ci block:\r?\n\[Hyperion\] {2}ci:\r?\n {2}provider: jenkins/);
    assert.match(out, / {4}- "\.github\/workflows\/build\.yml"/);
    assert.match(out, /# gates: run \/pipeline/);
    assert.match(out, /Detection complete\. Run: npm run hyperion:pipeline-plan/);
  });

  it("an empty repo has no product CI and lists no workflows", () => {
    const out = detect(makeRepo({}));
    assert.match(out, /Provider: github-actions/);
    assert.match(out, /Stack: unknown/);
    assert.match(out, /Product CI present: no/);
    assert.doesNotMatch(out, /Product workflows:|Hyperion workflows:|Legacy \(migrate\):|External CI:/);
  });
});
