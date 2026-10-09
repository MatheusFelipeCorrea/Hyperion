import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBranchFlow } from "./branch-flow.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "branch-flow.mjs");

test("allows only the one-step promotions from this repository", () => {
  assert.equal(checkBranchFlow({ base: "qa", head: "dev" }).ok, true);
  assert.equal(checkBranchFlow({ base: "main", head: "qa" }).ok, true);
  assert.equal(checkBranchFlow({ base: "internal", head: "main" }).ok, true);
  assert.equal(checkBranchFlow({ base: "dev", head: "feat/anything", sameRepo: false }).ok, true);
});

test("rejects skipping a step and says where the PR should go", () => {
  const r = checkBranchFlow({ base: "main", head: "dev" });
  assert.equal(r.ok, false);
  assert.equal(r.title, "PR into main must come from qa");
  assert.match(r.message, /Merge it into 'dev' first/);

  const feature = checkBranchFlow({ base: "qa", head: "feat/x" });
  assert.match(feature.message, /base: dev/);

  assert.match(checkBranchFlow({ base: "internal", head: "dev" }).message, /internal-sync\.yml/);
});

test("a fork's branch named dev is not this repository's dev", () => {
  const r = checkBranchFlow({ base: "qa", head: "dev", sameRepo: false });
  assert.equal(r.ok, false);
  assert.match(r.message, /a fork \('dev'\)/);
});

test("CLI exits 1 with a GitHub error annotation, 0 when allowed, 2 on bad usage", () => {
  const env = { ...process.env, GITHUB_STEP_SUMMARY: "", BASE_REF: "", HEAD_REF: "", HEAD_REPO: "", BASE_REPO: "" };
  const bad = spawnSync(process.execPath, [scriptPath, "--base", "main", "--head", "feat/x"], { encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /::error title=PR into main must come from qa::/);

  const fork = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...env, BASE_REF: "qa", HEAD_REF: "dev", HEAD_REPO: "someone/Hyperion", BASE_REPO: "owner/Hyperion" },
  });
  assert.equal(fork.status, 1);

  const ok = spawnSync(process.execPath, [scriptPath, "--base", "qa", "--head", "dev"], { encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);

  assert.equal(spawnSync(process.execPath, [scriptPath], { encoding: "utf8", env }).status, 2);
});
