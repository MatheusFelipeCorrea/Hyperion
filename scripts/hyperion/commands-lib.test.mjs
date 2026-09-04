import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCommandsYaml,
  buildClaudeRows,
  buildSkillIndex,
  buildSkillsSection,
  buildAgentsSection,
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
