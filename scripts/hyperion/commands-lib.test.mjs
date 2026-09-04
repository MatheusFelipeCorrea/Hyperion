import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCommandsYaml,
  buildClaudeRows,
  buildSkillIndex,
  buildSkillsSection,
  buildAgentsSection,
  loadCommands,
  normalizeEol,
  replaceMarkedSection,
  replaceTextSection,
  MARKER_START,
  MARKER_END,
  SKILLS_MARKER_START,
  SKILLS_MARKER_END,
} from "./commands-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");

describe("parseCommandsYaml", () => {
  it("parses agent type and npm shortcuts", () => {
    const yaml = readFileSync(join(repoRoot, ".github/commands.yml"), "utf8");
    const { commands, npmShortcuts } = parseCommandsYaml(yaml);
    assert.ok(commands.some((c) => c.phrase === "/execute" && c.type === "agent"));
    assert.ok(commands.some((c) => c.phrase === "/implement" && c.skill === "implementation-plan"));
    assert.ok(npmShortcuts.length >= 5);
  });
});

describe("commands.yml / filesystem parity", () => {
  // The same class of bug the package.json <-> cli.mjs COMMANDS parity test
  // (cli.test.mjs) catches: a hand-maintained registry drifting from what
  // actually exists on disk. skillPath() in commands-lib.mjs silently falls
  // back to a glob-pattern STRING (`.github/skills/**/${skill}/SKILL.md`)
  // for an unknown skill name instead of erroring — so a typo in
  // commands.yml would render a broken-looking path in CLAUDE.md/hyperion.mdc
  // forever without this test ever failing.
  it("every non-agent, skill-backed command resolves to a real SKILL.md (no wildcard fallback)", () => {
    const { commands } = loadCommands();
    const skillIndex = buildSkillIndex();
    const unresolved = [];

    for (const cmd of commands) {
      if (cmd.type === "agent" || !cmd.skill) continue;
      if (!skillIndex.has(cmd.skill)) unresolved.push(`${cmd.phrase} -> skill "${cmd.skill}"`);
    }

    assert.deepEqual(unresolved, []);
  });

  it("every agent-type command's .agent.md file actually exists", () => {
    const { commands } = loadCommands();
    const missing = [];

    for (const cmd of commands) {
      if (cmd.type !== "agent") continue;
      const agentPath = join(repoRoot, ".github/agents", `${cmd.skill}.agent.md`);
      if (!existsSync(agentPath)) missing.push(`${cmd.phrase} -> ${agentPath}`);
    }

    assert.deepEqual(missing, []);
  });

  it("every command's npm shortcut resolves to a real package.json script", () => {
    const { commands } = loadCommands();
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const missing = [];

    for (const cmd of commands) {
      if (!cmd.npm) continue;
      const scriptName = cmd.npm.split(" ")[0]; // strip " -- --yes" style args
      if (!pkg.scripts[scriptName]) missing.push(`${cmd.phrase} -> npm run ${scriptName}`);
    }

    assert.deepEqual(missing, []);
  });
});

describe("buildSkillsSection", () => {
  it("lists all four categories with skills", () => {
    const section = buildSkillsSection(repoRoot);
    assert.match(section, /planning/);
    assert.match(section, /release-manager/);
    assert.match(section, /pipeline-architect/);
  });
});

describe("buildAgentsSection", () => {
  it("lists eight agent files", () => {
    const section = buildAgentsSection(repoRoot);
    assert.match(section, /pr-reviewer\.agent\.md/);
    assert.match(section, /migration\.agent\.md/);
  });
});

describe("replaceMarkedSection", () => {
  it("replaces command block between markers", () => {
    const input = `before\n${MARKER_START}\nold\n${MARKER_END}\nafter`;
    const out = replaceMarkedSection(input, ["| /help | ok |"]);
    assert.match(out, /\| \/help \| ok \|/);
    assert.doesNotMatch(out, /old/);
  });
});

describe("replaceTextSection", () => {
  it("replaces skills catalog block", () => {
    const input = `${SKILLS_MARKER_START}\nold skills\n${SKILLS_MARKER_END}`;
    const out = replaceTextSection(input, "new skills", SKILLS_MARKER_START, SKILLS_MARKER_END);
    assert.match(out, /new skills/);
  });
});

describe("normalizeEol", () => {
  it("converts CRLF to LF", () => {
    assert.equal(normalizeEol("a\r\nb"), "a\nb");
  });
});

describe("buildClaudeRows", () => {
  it("maps agents to .agent.md paths", () => {
    const yaml = readFileSync(join(repoRoot, ".github/commands.yml"), "utf8");
    const { commands } = parseCommandsYaml(yaml);
    const rows = buildClaudeRows(commands, buildSkillIndex(repoRoot));
    assert.ok(rows.some((r) => r.includes("/execute") && r.includes("implementation-executor.agent.md")));
  });
});
