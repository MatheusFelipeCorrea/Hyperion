import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveCommand } from "./cli.mjs";
import { cleanupTmp, hyperionDir, makeTmp, relocateEnv, runNode } from "./test-support/cli-harness.mjs";

const cli = join(hyperionDir, "cli.mjs");

after(cleanupTmp);

describe("cli.mjs resolveCommand defaults", () => {
  it("defaults to help, maps --help/-h and cards defaults to sync", () => {
    assert.equal(resolveCommand([]).script, "help.mjs");
    assert.deepEqual(resolveCommand(["-h"]), { dir: "hyperion", script: "help.mjs", forward: [], label: "help" });
    assert.deepEqual(resolveCommand(["cards"]), { dir: "cards", script: "sync.mjs", forward: [], label: "cards sync" });
    assert.deepEqual(resolveCommand(["cards", "doctor", "--yes"]).forward, ["--interactive", "--yes"]);
    assert.match(resolveCommand(["cards", "nope"]).error, /Unknown cards subcommand: nope/);
  });
});

describe("cli.mjs entry point", () => {
  it("cli-help / commands list every command", () => {
    for (const arg of ["cli-help", "commands"]) {
      const r = runNode(cli, [arg], { cwd: makeTmp() });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Usage: hyperion <command> \[args\]/);
      assert.match(r.stdout, /upgrade\s+Upgrade kit from GitHub origin/);
    }
  });

  it("unknown commands print the error and the command list, exit 1", () => {
    const r = runNode(cli, ["nope"], { cwd: makeTmp() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command: nope/);
    assert.match(r.stdout, /Commands:/);
    const cards = runNode(cli, ["cards", "nope"], { cwd: makeTmp() });
    assert.equal(cards.status, 1);
    assert.match(cards.stderr, /Unknown cards subcommand/);
  });

  it("runs help.mjs by default and for --help", () => {
    for (const args of [[], ["--help"]]) {
      const r = runNode(cli, args, { cwd: makeTmp() });
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /Hyperion — one-liners \(npm\)/);
      assert.match(r.stdout, /Agent phrases \(no terminal — preferred\)/);
      assert.match(r.stdout, /Docs: \.github\/docs\/reference\/comandos-rapidos\.md/);
    }
  });

  it("forwards args to kit scripts in the cwd and propagates their exit code", () => {
    const cwd = makeTmp();
    const r = runNode(cli, ["telemetry", "--json"], { cwd });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), { enabled: false, events: 0, counts: {} });
    const cards = runNode(cli, ["cards", "validate"], { cwd });
    assert.equal(cards.status, 0, cards.out);
    assert.match(cards.stdout, /\[validate\] No card files found/);
  });

  it("reports a missing script when the kit's scripts/ were not copied", () => {
    const lonely = join(makeTmp("cli-lonely-"), "cli.mjs");
    const r = runNode(cli, ["doctor"], { cwd: makeTmp(), env: relocateEnv(cli, lonely) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Script missing: .*doctor\.mjs/);
    assert.match(r.stderr, /Copy the Hyperion kit/);
  });
});
