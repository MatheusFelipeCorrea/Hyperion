import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CliArgError, optionValue, parseRootArg } from "./cli-args.mjs";

describe("optionValue", () => {
  it("reads `--flag value` and `--flag=value`", () => {
    assert.equal(optionValue(["--check", "--root", "repo"], "--root"), "repo");
    assert.equal(optionValue(["--root=repo", "--check"], "--root"), "repo");
    assert.equal(optionValue(["--root=a=b"], "--root"), "a=b");
  });

  it("returns null when the flag is absent and ignores look-alike flags", () => {
    assert.equal(optionValue([], "--root"), null);
    assert.equal(optionValue(["--rooted", "x", "--root-dir=y"], "--root"), null);
  });

  it("rejects a missing, empty or option-like value", () => {
    assert.throws(() => optionValue(["--check", "--root"], "--root"), { message: "--root needs a value" });
    assert.throws(() => optionValue(["--root", ""], "--root"), CliArgError);
    assert.throws(() => optionValue(["--root="], "--root"), { message: "--root= needs a value" });
    assert.throws(() => optionValue(["--root", "--check"], "--root"), { message: '--root needs a value (got option "--check")' });
    assert.throws(() => optionValue(["--root", "-h"], "--root"), CliArgError);
  });
});

describe("parseRootArg", () => {
  it("resolves the value against the cwd and falls back when absent", () => {
    assert.equal(parseRootArg(["--root", "some/dir"], "/fallback"), resolve("some/dir"));
    assert.equal(parseRootArg(["--root=some/dir"]), resolve("some/dir"));
    assert.equal(parseRootArg(["--check"], "/fallback"), "/fallback");
    assert.equal(parseRootArg([]), null);
  });
});

describe("rootArg", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hyperion-cli-args-")));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "print-root.mjs");
  const helper = new URL("./cli-args.mjs", import.meta.url).href;
  writeFileSync(script, `import { rootArg } from ${JSON.stringify(helper)};\nconsole.log(rootArg("FALLBACK"));\n`);
  const run = (args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });

  it("prints the parsed root, or the fallback when --root is absent", () => {
    assert.equal(run(["--root=sub"]).stdout.trim(), join(dir, "sub"));
    assert.equal(run(["--check"]).stdout.trim(), "FALLBACK");
  });

  it("exits 2 with the reason on a malformed --root", () => {
    for (const args of [["--root", "--check"], ["--check", "--root"], ["--root="]]) {
      const r = run(args);
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^Error: --root=? needs a value/);
    }
  });
});
