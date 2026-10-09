import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "generate-runtime-rules.mjs");

const MARKED = `# Rules

<!-- HYPERION:COMMANDS:START -->
stale
<!-- HYPERION:COMMANDS:END -->

<!-- HYPERION:SKILLS:START -->
<!-- HYPERION:SKILLS:END -->

<!-- HYPERION:AGENTS:START -->
<!-- HYPERION:AGENTS:END -->

<!-- HYPERION:LANGUAGE:START -->
<!-- HYPERION:LANGUAGE:END -->
`;

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

/** Minimal kit tree: generate-runtime-rules writes into <root>, never into this repo. */
function makeKit() {
  const root = mkdtempSync(join(tmpdir(), "hyperion-gen-rules-"));
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write(
    ".github/commands.yml",
    `commands:
  - phrase: "/help"
    skill: null
    npm: "hyperion:help"
    description: "List shortcuts"
  - phrase: "/execute"
    skill: "implementation-executor"
    type: agent
    description: "Run approved phases"
  - phrase: "/spec"
    skill: "spec-writer"
    description: "write a spec"
npm_shortcuts:
  - cmd: "npm run hyperion:help"
    desc: "List shortcuts"
`
  );
  write(".github/skills/planning/spec-writer/SKILL.md", "---\nname: spec-writer\ndescription: Specs\n---\n");
  write(".github/agents/implementation-executor.agent.md", "# exec\n");
  write("CLAUDE.md", MARKED);
  write(".cursor/rules/hyperion.mdc", MARKED.replace(/\n/g, "\r\n"));
  write(".github/copilot-instructions.md", MARKED);
  write("scripts/hyperion/help.mjs", "// stale\n");
  return root;
}

describe("generate-runtime-rules --root", () => {
  let root;
  before(() => {
    root = makeKit();
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("--check reports drift on a stale tree without writing", () => {
    const r = run(["--check", "--root", root]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Drift detected: .*scripts\/hyperion\/help\.mjs/);
    assert.match(r.stderr, /Drift detected: .*CLAUDE\.md/);
    assert.match(r.stderr, /Runtime rules out of sync/);
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), MARKED);
  });

  it("write mode regenerates help.mjs and every runtime target under the given root", () => {
    const r = run(["--root", root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((r.stdout.match(/^Updated /gm) || []).length, 4);
    assert.match(r.stdout, /Done\. Commit generated files/);

    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.match(claude, /\| \/execute \| \.github\/agents\/implementation-executor\.agent\.md \|/);
    assert.match(claude, /\| \/spec \| `\.github\/skills\/planning\/spec-writer\/SKILL\.md` \|/);
    assert.match(claude, /- \*\*planning\/\*\* — spec-writer/);
    assert.match(claude, /implementation-executor\.agent\.md` — execute approved plan phases/);
    assert.match(claude, /Read `locale`/);
    assert.doesNotMatch(claude, /stale/);

    const cursor = readFileSync(join(root, ".cursor/rules/hyperion.mdc"), "utf8");
    assert.doesNotMatch(cursor, /\r\n/);
    assert.match(cursor, /`\/help` or "lista comandos Hyperion"/);

    const copilot = readFileSync(join(root, ".github/copilot-instructions.md"), "utf8");
    assert.match(copilot, /\| Write a spec \| `spec-writer` — or user says `\/spec` \|/);

    const help = readFileSync(join(root, "scripts/hyperion/help.mjs"), "utf8");
    assert.match(help, /AUTO-GENERATED/);
  });

  it("--check passes once the tree is in sync", () => {
    const r = run(["--check", "--root", root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Runtime rules in sync/);
  });

  it("fails loudly when a runtime target lacks its markers", () => {
    const broken = makeKit();
    try {
      writeFileSync(join(broken, "CLAUDE.md"), "# no markers\n");
      const r = run(["--check", "--root", broken]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /markers not found/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
