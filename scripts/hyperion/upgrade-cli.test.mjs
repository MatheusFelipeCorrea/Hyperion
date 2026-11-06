import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, gitCommitAll, githubToLocalEnv, hyperionDir, makeBin, makeTmp, runNodeAsync, writeFiles } from "./test-support/cli-harness.mjs";

const upgrade = join(hyperionDir, "upgrade.mjs");

function kitFiles(version, extraScripts = 0) {
  const files = {
    "scripts/hyperion/doctor.mjs": `export const v = ${version};\n`,
    ".github/commands.yml": `version: ${version}\n`,
    "package.json": { name: "hyperion", description: "kit", scripts: { "hyperion:doctor": "node scripts/hyperion/doctor.mjs" } },
  };
  for (let i = 0; i < extraScripts; i++) files[`scripts/hyperion/extra-${String(i).padStart(2, "0")}.mjs`] = `// ${i}\n`;
  return files;
}

function client(files = {}) {
  return writeFiles(makeTmp("upgrade-client-"), {
    ".github/project.yml": "name: client\n",
    "package.json": { name: "acme-app", scripts: { start: "node app.js" } },
    ...files,
  });
}

let remotes;
let sha;
let ghFail;

before(() => {
  remotes = makeTmp("upgrade-remotes-");
  sha = gitCommitAll(writeFiles(join(remotes, "acme", "kit.git"), kitFiles(2)));
  ghFail = makeBin({ gh: "fail" });
});

after(cleanupTmp);

/** Remote mode: gh "missing", github.com rewritten to the local `remotes` dir. */
function remote(cwd, args) {
  return runNodeAsync(upgrade, args, { cwd, binDir: ghFail, env: githubToLocalEnv(remotes) });
}

describe("upgrade.mjs --from (local kit)", { concurrency: true }, () => {
  it("--help prints usage", async () => {
    const r = await runNodeAsync(upgrade, ["--help"], { cwd: makeTmp() });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Pin file:\s+\.github\/hyperion-kit\.json/);
  });

  it("rejects a missing path, a non-kit dir and the cwd itself", async () => {
    const cwd = client(kitFiles(1));
    let r = await runNodeAsync(upgrade, ["--from", join(cwd, "nope")], { cwd });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Kit path not found/);

    r = await runNodeAsync(upgrade, [`--from=${makeTmp("not-a-kit-")}`], { cwd });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Not a Hyperion kit/);

    r = await runNodeAsync(upgrade, ["--from", "."], { cwd });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /same as cwd/);
  });

  it("dry-run lists at most 40 paths and writes nothing", async () => {
    const kit = writeFiles(makeTmp("upgrade-kit-"), kitFiles(2, 45));
    const cwd = client();
    const r = await runNodeAsync(upgrade, ["--from", kit, "--dry-run"], { cwd });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Mode: DRY-RUN/);
    assert.match(r.stdout, /ADD\s+scripts\/hyperion\/doctor\.mjs/);
    assert.match(r.stdout, /… \+8 more/);
    assert.match(r.stdout, /Plan: \+47 add · ~1 update · =0 same · ⊘0 preserve/);
    assert.equal(existsSync(join(cwd, "scripts")), false);
  });

  it("--yes applies the kit (HYPERION_KIT_ROOT works as --from)", async () => {
    const kit = writeFiles(makeTmp("upgrade-kit-"), kitFiles(3));
    const cwd = client();
    const r = await runNodeAsync(upgrade, ["-y"], { cwd, env: { HYPERION_KIT_ROOT: kit } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Applied \d+ paths/);
    assert.equal(readFileSync(join(cwd, "scripts", "hyperion", "doctor.mjs"), "utf8"), "export const v = 3;\n");
    assert.equal(readFileSync(join(cwd, ".github", "project.yml"), "utf8"), "name: client\n");
    const pin = JSON.parse(readFileSync(join(cwd, ".github", "hyperion-kit.json"), "utf8"));
    assert.equal(pin.source, kit);
  });
});

describe("upgrade.mjs (remote origin)", { concurrency: true }, () => {
  const origin = { ".github/hyperion-origin.json": { repo: "acme/kit", ref: "main" } };

  it("is up to date when the pin matches the remote tip (with and without --check)", async () => {
    const cwd = client({ ...origin, ".github/hyperion-kit.json": { commit: sha } });
    for (const args of [[], ["--check"]]) {
      const r = await remote(cwd, args);
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /Origin: github\.com\/acme\/kit@main/);
      assert.match(r.stdout, /\(git-ls-remote\)/);
      assert.match(r.stdout, /Already up to date/);
    }
  });

  it("--check exits 1 when there is no pin yet", async () => {
    const r = await remote(client(origin), ["--check"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /No \.github\/hyperion-kit\.json pin yet/);
    assert.match(r.stdout, /Updates available/);
  });

  it("dry-run against a stale pin clones the kit and shows the plan", async () => {
    const cwd = client({ ...origin, ".github/hyperion-kit.json": { commit: "0000000000000000" } });
    const r = await remote(cwd, ["--repo=acme/kit", "--ref=main"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Local pin 000000000000 ≠ remote/);
    assert.match(r.stdout, new RegExp(`Source: github\\.com/acme/kit@main \\(${sha.slice(0, 12)}\\)`));
    assert.match(r.stdout, /dry-run complete/);
    assert.equal(existsSync(join(cwd, "scripts")), false);
  });

  it("--yes fetches, applies and pins the remote commit", async () => {
    const cwd = client();
    const r = await remote(cwd, ["--repo", "acme/kit", "--ref", "main", "--yes"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /hyperion:upgrade complete/);
    assert.match(readFileSync(join(cwd, "scripts", "hyperion", "doctor.mjs"), "utf8"), /v = 2/);
    const pin = JSON.parse(readFileSync(join(cwd, ".github", "hyperion-kit.json"), "utf8"));
    assert.deepEqual([pin.repo, pin.ref, pin.commit], ["acme/kit", "main", sha]);
  });

  it("fails cleanly when the origin can't be resolved", async () => {
    const r = await remote(client(), ["--repo", "acme/missing"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Could not resolve acme\/missing@main/);
  });
});
