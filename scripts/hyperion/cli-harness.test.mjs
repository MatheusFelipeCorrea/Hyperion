import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { childEnv, cleanupTmp, git, makeBin, makeTmp } from "./test-support/cli-harness.mjs";

// The harness itself: what every CLI test relies on to stay offline and machine-independent.
after(cleanupTmp);

describe("cli-harness", () => {
  it("childEnv drops CI and every GITHUB_* unless opted back in, and fences git into the temp root", () => {
    const saved = { CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, GITHUB_SHA: process.env.GITHUB_SHA };
    Object.assign(process.env, { CI: "true", GITHUB_ACTIONS: "true", GITHUB_SHA: "abc" });
    try {
      const env = childEnv({ GITHUB_REPOSITORY: "acme/app", DROP_ME: undefined }, { binDir: "BIN" });
      assert.equal(env.CI, undefined);
      assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase().startsWith("GITHUB_")), ["GITHUB_REPOSITORY"]);
      assert.equal(env.GIT_CEILING_DIRECTORIES, realpathSync.native(tmpdir()));
      assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === "PATH"), ["PATH"]);
      assert.ok(env.PATH.startsWith(`BIN${delimiter}`));
      assert.ok(!("DROP_ME" in env));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("git() throws with git's message outside a repository", () => {
    assert.throws(() => git(makeTmp("harness-norepo-"), ["rev-parse", "--git-dir"]), /git rev-parse --git-dir failed: .*not a git repository/i);
  });

  it("makeBin stubs resolve on this platform: gh fails or runs node, npm exits with the given code", () => {
    const run = (cmd, args, binDir, opts = {}) => spawnSync(cmd, args, { env: childEnv({}, { binDir }), encoding: "utf8", windowsHide: true, ...opts });

    const fail = run("gh", ["auth", "token"], makeBin({ gh: "fail" }));
    assert.ok(fail.error || fail.status === 1, "gh stub must fail");

    const [a, b] = [makeBin({ gh: "node" }), makeBin({ gh: "node" })];
    assert.equal(run("gh", ["-e", "console.log(6 * 7)"], a).stdout.trim(), "42");
    assert.equal(statSync(join(a, "gh.exe")).ino, statSync(join(b, "gh.exe")).ino, "node is copied once per run, then hard-linked");

    assert.equal(run("npm install", [], makeBin({ npm: 0 }), { shell: true }).status, 0);
    assert.equal(run("npm install", [], makeBin({ npm: 3 }), { shell: true }).status, 3);
  });
});
