import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCommand, COMMANDS } from "./cli.mjs";

describe("hyperion cli resolveCommand", () => {
  it("maps doctor", () => {
    const r = resolveCommand(["doctor"]);
    assert.equal(r.script, "doctor.mjs");
    assert.equal(r.dir, "hyperion");
  });

  it("maps project-verify with args", () => {
    const r = resolveCommand(["project-verify", "--root", "."]);
    assert.equal(r.script, "project-verify.mjs");
    assert.deepEqual(r.forward, ["--root", "."]);
  });

  it("maps check-rules to --check", () => {
    const r = resolveCommand(["check-rules"]);
    assert.deepEqual(r.forward, ["--check"]);
  });

  it("maps cards sync dry-run", () => {
    const r = resolveCommand(["cards", "dry-run"]);
    assert.equal(r.dir, "cards");
    assert.equal(r.script, "sync.mjs");
    assert.ok(r.forward.includes("--dry-run"));
  });

  it("errors on unknown", () => {
    const r = resolveCommand(["nope"]);
    assert.ok(r.error);
  });

  it("exposes core verify commands", () => {
    assert.ok(COMMANDS["phase-verify"]);
    assert.ok(COMMANDS["project-verify"]);
    assert.ok(COMMANDS["review-verify"]);
    assert.ok(COMMANDS.upgrade);
  });
});

describe("cli.mjs / package.json parity", () => {
  // This is the regression guard for a bug that kept escaping audit rounds
  // (6 → 7 → 8 missing commands, each time undercounted): COMMANDS and
  // package.json's scripts are two hand-maintained lists of the same
  // thing. Anything hyperion:*/docs:*/skills:* is meant to be reachable
  // via `docker run hyperion-cli <command>` — if it isn't in COMMANDS, the
  // Docker/CLI entrypoint silently can't run it even though `npm run`
  // works fine, and nothing else catches that gap.
  const EXCLUDED_SCRIPTS = new Set([
    "hyperion:cli", // this CLI itself
    "hyperion:docker-build", // shells out to `docker`, not routed via cli.mjs
    "hyperion:sbom", // shells out to `npm sbom`, not routed via cli.mjs
    "hyperion:test", // test runner, needs shell glob expansion
    "cards:test", // test runner, needs shell glob expansion
    "test", // meta script
    "test:coverage", // meta script
  ]);

  it("every hyperion:*/docs:*/skills:* npm script has a matching COMMANDS entry", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(path.join(here, "..", "..", "package.json"), "utf8"));

    const missing = [];
    for (const name of Object.keys(pkg.scripts)) {
      if (!/^(hyperion|docs|skills):/.test(name)) continue;
      if (EXCLUDED_SCRIPTS.has(name)) continue;
      const key = name.replace(/^hyperion:/, "").replace(/:/g, "-");
      if (!COMMANDS[key]) missing.push(name);
    }

    assert.deepEqual(missing, [], `package.json scripts with no cli.mjs COMMANDS entry: ${missing.join(", ")}`);
  });

  it("every COMMANDS entry's backing script actually exists on disk", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const hyperionDir = path.dirname(fileURLToPath(import.meta.url));

    const missing = Object.entries(COMMANDS)
      .filter(([, spec]) => !existsSync(path.join(hyperionDir, spec.script)))
      .map(([key]) => key);

    assert.deepEqual(missing, []);
  });
});
