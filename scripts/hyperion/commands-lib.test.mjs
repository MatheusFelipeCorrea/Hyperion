import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCommandsYaml,
  loadCommands,
  buildClaudeRows,
  buildCursorRows,
  buildCopilotRows,
  buildHelpContent,
  buildLanguageSection,
  buildSkillIndex,
  buildSkillsSection,
  buildAgentsSection,
  normalizeEol,
  replaceMarkedSection,
  replaceTextSection,
  runtimeTargets,
  RUNTIME_TARGETS,
  repoRoot as libRepoRoot,
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

const FIXTURE_YAML = `# fixture
commands:
  - phrase: "/help"
    skill: null
    npm: "hyperion:help"
    description: "List shortcuts"

  - phrase: "/setup"
    skill: "project-startup"
    npm: "hyperion:setup -- --yes"
    description: "Full guided setup"

  - phrase: "/doctor"
    skill: "hyperion-ops"
    npm: "hyperion:doctor"
    description: "Kit health check"

  - phrase: "/sync"
    skill: "hyperion-ops"
    npm: "hyperion:sync"
    description: "Sync cards"

  - phrase: "/execute"
    skill: "implementation-executor"
    type: agent
    description: "Run approved phases"

  - phrase: "/spec"
    skill: "spec-writer"
    description: "write a spec"

  - phrase: "/lint"
    skill: null
    npm: "lint"
    description: "Run Lint"

npm_shortcuts:
  - cmd: "npm run hyperion:doctor"
    desc: "Health check"
  - cmd: "npm run hyperion:sync"
`;

describe("commands-lib on a fixture kit", () => {
  let root;
  let commands;
  let npmShortcuts;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "hyperion-cmdlib-"));
    mkdirSync(join(root, ".github", "skills", "planning", "spec-writer"), { recursive: true });
    mkdirSync(join(root, ".github", "skills", "setup", "renamed-folder"), { recursive: true });
    mkdirSync(join(root, ".github", "agents"), { recursive: true });
    writeFileSync(join(root, ".github", "commands.yml"), FIXTURE_YAML);
    writeFileSync(
      join(root, ".github", "skills", "planning", "spec-writer", "SKILL.md"),
      "\uFEFF---\nname: spec-writer\ndescription: >-\n  Writes specs\n  in two lines\n---\n"
    );
    writeFileSync(
      join(root, ".github", "skills", "setup", "renamed-folder", "SKILL.md"),
      "---\nname: \"project-startup\"\ndescription: 'Setup'\n---\n"
    );
    writeFileSync(join(root, ".github", "skills", "setup", "renamed-folder", "notes.md"), "not a skill\n");
    writeFileSync(join(root, ".github", "skills", "README.md"), "no frontmatter\n");
    mkdirSync(join(root, ".github", "skills", "quality", "broken"), { recursive: true });
    writeFileSync(join(root, ".github", "skills", "quality", "broken", "SKILL.md"), "---\nname: never-closed\n");
    writeFileSync(join(root, ".github", "skills", "quality", "broken-too.md"), "x");
    writeFileSync(join(root, ".github", "agents", "release.agent.md"), "# release\n");
    writeFileSync(join(root, ".github", "agents", "custom-thing.agent.md"), "# custom\n");
    writeFileSync(join(root, ".github", "agents", "README.md"), "# agents\n");
    ({ commands, npmShortcuts } = loadCommands(root));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("loadCommands reads <root>/.github/commands.yml (skill null, npm, type, shortcuts without desc)", () => {
    assert.deepEqual(
      commands.map((c) => c.phrase),
      ["/help", "/setup", "/doctor", "/sync", "/execute", "/spec", "/lint"]
    );
    assert.equal(commands[0].skill, null);
    assert.equal(commands[0].npm, "hyperion:help");
    assert.equal(commands[4].type, "agent");
    assert.deepEqual(npmShortcuts, [
      { cmd: "npm run hyperion:doctor", desc: "Health check" },
      { cmd: "npm run hyperion:sync", desc: "" },
    ]);
  });

  it("buildSkillIndex maps frontmatter names and folder names, ignoring files without frontmatter", () => {
    const index = buildSkillIndex(root);
    assert.equal(index.get("spec-writer"), ".github/skills/planning/spec-writer/SKILL.md");
    assert.equal(index.get("project-startup"), ".github/skills/setup/renamed-folder/SKILL.md");
    assert.equal(index.get("renamed-folder"), ".github/skills/setup/renamed-folder/SKILL.md");
    assert.equal(index.get("broken"), ".github/skills/quality/broken/SKILL.md");
    assert.equal(index.has("never-closed"), false);
  });

  it("buildClaudeRows covers npm-only, agent, hyperion-ops and plain/unknown skills", () => {
    const rows = buildClaudeRows(commands, buildSkillIndex(root));
    assert.deepEqual(rows, [
      "| /help | Run `npm run hyperion:help` — list shortcuts |",
      "| /setup | `.github/skills/setup/renamed-folder/SKILL.md` |",
      "| /doctor | `.github/skills/**/hyperion-ops/SKILL.md` → `npm run hyperion:doctor` |",
      "| /sync | `.github/skills/**/hyperion-ops/SKILL.md` → `npm run hyperion:sync` |",
      "| /execute | .github/agents/implementation-executor.agent.md |",
      "| /spec | `.github/skills/planning/spec-writer/SKILL.md` |",
      "| /lint | Run `npm run lint` — run lint |",
    ]);
  });

  it("buildCursorRows uses aliases when known and maps each action kind", () => {
    assert.deepEqual(buildCursorRows(commands), [
      '| `/help` or "lista comandos Hyperion" | `npm run hyperion:help` + summarize |',
      '| `/setup` or "configura o Hyperion" | `project-startup` |',
      '| `/doctor` or "doctor do Hyperion" | `hyperion-ops` → `npm run hyperion:doctor` |',
      '| `/sync` or "sincroniza os cards" | `hyperion-ops` → `npm run hyperion:sync` |',
      "| `/execute` | `implementation-executor` agent |",
      "| `/spec` | `spec-writer` |",
      "| `/lint` | `npm run lint` + summarize |",
    ]);
  });

  it("buildCopilotRows skips /help, collapses hyperion-ops and bolds Full* needs", () => {
    assert.deepEqual(buildCopilotRows(commands), [
      "| **Full Hyperion setup** | `project-startup` — or user says `/setup` |",
      "| **Sync / doctor / validate cards** | `hyperion-ops` — runs `npm run hyperion:sync`, `hyperion:doctor` |",
      "| Run approved phases | `implementation-executor` agent |",
      "| Write a spec | `spec-writer` — or user says `/spec` |",
      "| Run Lint | `npm run lint` |",
    ]);
  });

  it("buildSkillsSection lists category folders and tolerates missing categories", () => {
    const section = buildSkillsSection(root);
    assert.match(section, /- \*\*planning\/\*\* — spec-writer/);
    assert.match(section, /- \*\*setup\/\*\* — renamed-folder/);
    assert.match(section, /- \*\*quality\/\*\* — broken$/m);
    assert.match(section, /- \*\*docs\/\*\* — $/m);
  });

  it("buildAgentsSection describes known agents and falls back for unknown ones", () => {
    const section = buildAgentsSection(root);
    assert.deepEqual(section.split("\n").slice(0, 2), [
      "- `.github/agents/custom-thing.agent.md` — see agent file",
      "- `.github/agents/release.agent.md` — changelog, version, tag (`/release`)",
    ]);
    assert.doesNotMatch(section, /README\.md` —/);
  });

  it("buildLanguageSection states the language contract", () => {
    const section = buildLanguageSection();
    assert.match(section, /^Read `locale`/);
    assert.match(section, /\| Code, identifiers, branches.*\| Always English \|/);
  });

  it("buildHelpContent embeds npm shortcuts and agent phrases", () => {
    const help = buildHelpContent(commands, npmShortcuts);
    assert.match(help, /AUTO-GENERATED from \.github\/commands\.yml/);
    assert.ok(help.includes('[["hyperion:doctor","Health check"],["hyperion:sync",""]]'));
    assert.ok(help.includes('["/setup","project-startup — Full guided setup"]'));
    assert.ok(help.includes('["/execute","implementation-executor agent — Run approved phases"]'));
    assert.ok(!help.includes('"/spec"'));
  });

  it("replaceMarkedSection / replaceTextSection throw when markers are missing", () => {
    assert.throws(() => replaceMarkedSection("no markers", ["x"]), /HYPERION:COMMANDS:START -->.*markers not found/);
    assert.throws(
      () => replaceTextSection("no markers", "x", SKILLS_MARKER_START, SKILLS_MARKER_END),
      /HYPERION:SKILLS:START -->.*markers not found/
    );
  });

  it("runtimeTargets(root) points CLAUDE/Cursor/Copilot targets at the given root", () => {
    const targets = runtimeTargets(root);
    assert.deepEqual(
      targets.map((t) => t.path),
      [join(root, "CLAUDE.md"), join(root, ".cursor/rules/hyperion.mdc"), join(root, ".github/copilot-instructions.md")]
    );
    assert.ok(targets.every((t) => t.syncCatalog));
    assert.deepEqual(targets[1].buildRows(commands), buildCursorRows(commands));
    assert.deepEqual(targets[2].buildRows(commands), buildCopilotRows(commands));
    assert.deepEqual(RUNTIME_TARGETS.map((t) => t.path), runtimeTargets(libRepoRoot).map((t) => t.path));
  });
});
