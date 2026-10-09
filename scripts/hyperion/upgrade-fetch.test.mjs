import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupTemp, readLocalKitMeta, resolveOrigin, sameCommit } from "./upgrade-fetch.mjs";
import {
  cleanupTmp,
  git,
  gitCommitAll,
  githubToLocalEnv,
  hyperionDir,
  makeBin,
  makeTmp,
  runNodeAsync,
  writeFiles,
} from "./test-support/cli-harness.mjs";

const ENV_KEYS = ["HYPERION_ORIGIN_REPO", "HYPERION_ORIGIN_REF"];

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const moduleUrl = pathToFileURL(join(hyperionDir, "upgrade-fetch.mjs")).href;
let driver;
let remotes;
let sha;
let ghNode;
let ghFail;

before(() => {
  remotes = makeTmp("upgrade-remotes-");
  const kit = join(remotes, "acme", "kit.git");
  writeFiles(kit, { "scripts/hyperion/doctor.mjs": "export const v = 1;\n", "package.json": { name: "hyperion" } });
  sha = gitCommitAll(kit);
  git(kit, ["tag", "v1"]);
  ghNode = makeBin({ gh: "node" });
  ghFail = makeBin({ gh: "fail" });
  driver = join(
    writeFiles(makeTmp("upgrade-fetch-driver-"), {
      "driver.mjs": [
        "const m = await import(process.env.UF_MODULE);",
        "const out = [];",
        "for (const [fn, ...args] of JSON.parse(process.argv[2])) {",
        "  try { out.push({ value: await m[fn](...args) }); } catch (e) { out.push({ error: e.message }); }",
        "}",
        "console.log(JSON.stringify(out));",
        "",
      ].join("\n"),
    }),
    "driver.mjs",
  );
});

after(cleanupTmp);

describe("upgrade-fetch: origin + local pin", () => {
  it("resolveOrigin normalizes URLs from hyperion-origin.json and honors env overrides", async () => {
    const dir = writeFiles(makeTmp("origin-"), {
      ".github/hyperion-origin.json": { repo: "https://github.com/acme/Kit.git", ref: "develop" },
    });
    await withEnv({}, async () => {
      assert.deepEqual(await resolveOrigin(dir), { repo: "acme/Kit", ref: "develop" });
    });
    await withEnv({ HYPERION_ORIGIN_REPO: "https://github.com/env/Repo.git", HYPERION_ORIGIN_REF: "v9" }, async () => {
      assert.deepEqual(await resolveOrigin(dir), { repo: "env/Repo", ref: "v9" });
    });
  });

  it("resolveOrigin falls back to the default origin on a missing or broken file", async () => {
    const dir = writeFiles(makeTmp("origin-bad-"), { ".github/hyperion-origin.json": "{ not json" });
    await withEnv({}, async () => {
      const o = await resolveOrigin(dir);
      assert.match(o.repo, /^[^/]+\/[^/]+$/);
      assert.ok(o.ref);
      const empty = writeFiles(makeTmp("origin-empty-"), { ".github/hyperion-origin.json": {} });
      assert.deepEqual(await resolveOrigin(empty), o);
    });
  });

  it("readLocalKitMeta returns the pin or null", async () => {
    const dir = writeFiles(makeTmp("pin-"), { ".github/hyperion-kit.json": { commit: "abc1234" } });
    assert.deepEqual(await readLocalKitMeta(dir), { commit: "abc1234" });
    assert.equal(await readLocalKitMeta(makeTmp("nopin-")), null);
  });

  it("sameCommit rejects empty and too-short shas", () => {
    assert.equal(sameCommit(null, "abc1234"), false);
    assert.equal(sameCommit("abc1234", ""), false);
    assert.equal(sameCommit("abc12", "abc12"), false);
    assert.equal(sameCommit("ABC1234", "abc1234ffff"), true);
  });

  it("cleanupTemp ignores null and swallows errors", () => {
    cleanupTemp(null);
    cleanupTemp(42);
    const dir = makeTmp("cleanup-");
    cleanupTemp(dir);
    assert.equal(existsSync(dir), false);
  });
});

// gh/git-backed cases run in child processes (own PATH, cwd and git URL rewrites)
// so they can run concurrently; each call list returns [{ value } | { error }].
async function callFetch(calls, { cwd, binDir, env = {} }) {
  const r = await runNodeAsync(driver, [JSON.stringify(calls)], { cwd, binDir, env: { ...env, UF_MODULE: moduleUrl } });
  assert.equal(r.status, 0, r.out);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

describe("upgrade-fetch: fetchRemoteTip", { concurrency: true }, () => {
  it("uses `gh api` when gh is available and answers a sha", async () => {
    const cwd = writeFiles(makeTmp("gh-api-"), { api: `console.log(${JSON.stringify(sha.toUpperCase())});\n` });
    const [avail, tip] = await callFetch([["ghAvailable"], ["fetchRemoteTip", "acme/kit", "main"]], { cwd, binDir: ghNode });
    assert.deepEqual(avail, { value: true });
    assert.deepEqual(tip, { value: { sha, method: "gh" } });
  });

  it("falls back to git ls-remote when gh answers garbage", async () => {
    const cwd = writeFiles(makeTmp("gh-garbage-"), { api: "console.log('not a sha');\n" });
    const [tip] = await callFetch([["fetchRemoteTip", "acme/kit", "main"]], { cwd, binDir: ghNode, env: githubToLocalEnv(remotes) });
    assert.deepEqual(tip, { value: { sha, method: "git-ls-remote" } });
  });

  it("without gh matches tags and the first ls-remote line, and throws a helpful error otherwise", async () => {
    const calls = [
      ["ghAvailable"],
      ["fetchRemoteTip", "acme/kit", "v1"],
      ["fetchRemoteTip", "acme/kit", "HEAD"],
      ["fetchRemoteTip", "acme/kit", "no-such-branch"],
      ["fetchRemoteTip", "acme/missing", "main"],
    ];
    const [avail, tag, head, noRef, noRepo] = await callFetch(calls, { cwd: makeTmp("gh-none-"), binDir: ghFail, env: githubToLocalEnv(remotes) });
    assert.deepEqual(avail, { value: false });
    assert.deepEqual(tag, { value: { sha, method: "git-ls-remote" } });
    assert.deepEqual(head, { value: { sha, method: "git-ls-remote" } });
    assert.match(noRef.error, /Could not resolve acme\/kit@no-such-branch/);
    assert.match(noRepo.error, /pass --from <local-kit>/);
  });
});

describe("upgrade-fetch: materializeKitFromGitHub", { concurrency: true }, () => {
  function assertKit({ value: mat, error }) {
    assert.equal(error, undefined);
    try {
      assert.match(readFileSync(join(mat.kitRoot, "scripts", "hyperion", "doctor.mjs"), "utf8"), /^export const v = 1;\r?\n$/);
      assert.equal(mat.sha, sha);
      assert.equal(mat.repo, "acme/kit");
      assert.equal(mat.ref, "main");
    } finally {
      cleanupTemp(mat.tempParent);
    }
    assert.equal(existsSync(mat.tempParent), false);
  }

  it("clones with the gh auth token when gh is logged in", async () => {
    const cwd = writeFiles(makeTmp("gh-auth-"), { auth: "console.log('gh-tok');\n" });
    const env = githubToLocalEnv(remotes, ["gh-tok"], { anonymous: false });
    assertKit((await callFetch([["materializeKitFromGitHub", "acme/kit", "main", sha.toUpperCase()]], { cwd, binDir: ghNode, env }))[0]);
  });

  it("clones anonymously when gh has no token", async () => {
    const env = githubToLocalEnv(remotes);
    assertKit((await callFetch([["materializeKitFromGitHub", "acme/kit", "main", sha]], { cwd: makeTmp("gh-noauth-"), binDir: ghNode, env }))[0]);
  });

  it("without gh uses GITHUB_TOKEN and resolves HEAD itself when no tip sha is given", async () => {
    const env = { GITHUB_TOKEN: "env-tok", ...githubToLocalEnv(remotes, ["env-tok"], { anonymous: false }) };
    assertKit((await callFetch([["materializeKitFromGitHub", "acme/kit", "main", ""]], { cwd: makeTmp("gh-envtok-"), binDir: ghFail, env }))[0]);
  });

  it("removes its temp dir and throws when the clone fails", async () => {
    const env = githubToLocalEnv(remotes);
    const [r] = await callFetch([["materializeKitFromGitHub", "acme/missing", "main", sha]], { cwd: makeTmp("gh-clonefail-"), binDir: ghFail, env });
    assert.match(r.error, /git clone failed/);
  });
});