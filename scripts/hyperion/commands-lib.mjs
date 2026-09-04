import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, "../..");
export const commandsPath = join(repoRoot, ".github/commands.yml");

export const MARKER_START = "<!-- HYPERION:COMMANDS:START -->";
export const MARKER_END = "<!-- HYPERION:COMMANDS:END -->";
export const AGENTS_MARKER_START = "<!-- HYPERION:AGENTS:START -->";
export const AGENTS_MARKER_END = "<!-- HYPERION:AGENTS:END -->";
export const SKILLS_MARKER_START = "<!-- HYPERION:SKILLS:START -->";
export const SKILLS_MARKER_END = "<!-- HYPERION:SKILLS:END -->";

const SKILL_CATEGORIES = ["planning", "setup", "quality", "docs"];

const AGENT_PHRASES_EXTRA = new Set([
  "/setup",
  "/doctor",
  "/sync",
  "/discover",
  "/refine",
  "/audit",
  "/review",
  "/implement",
  "/execute",
  "/connect",
]);

const CURSOR_ALIASES = {
  "/help": '"lista comandos Hyperion"',
  "/setup": '"configura o Hyperion"',
  "/doctor": '"doctor do Hyperion"',
  "/sync": '"sincroniza os cards"',
  "/discover": '"descobre esse projeto"',
  "/refine": '"refina em cards"',
  "/audit": '"auditoria completa"',
};

export function parseCommandsYaml(text) {
  const commands = [];
  const npmShortcuts = [];
  let section = null;
  let current = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("commands:")) {
      section = "commands";
      continue;
    }
    if (line.startsWith("npm_shortcuts:")) {
      section = "npm";
      current = null;
      continue;
    }
    if (section === "commands" && line.match(/^  - phrase:/)) {
      current = { phrase: line.split('"')[1] };
      commands.push(current);
      continue;
    }
    if (section === "commands" && current) {
      if (line.match(/skill: null/)) current.skill = null;
      const skill = line.match(/skill: "(.+)"/);
      const npm = line.match(/npm: "(.+)"/);
      const desc = line.match(/description: "(.+)"/);
      const type = line.match(/type: (\w+)/);
      if (skill) current.skill = skill[1];
      if (npm) current.npm = npm[1];
      if (desc) current.description = desc[1];
      if (type) current.type = type[1];
    }
    if (section === "npm" && line.match(/^  - cmd:/)) {
      npmShortcuts.push({ cmd: line.split('"')[1], desc: "" });
      continue;
    }
    if (section === "npm" && npmShortcuts.length && line.match(/desc:/)) {
      npmShortcuts[npmShortcuts.length - 1].desc = line.split('"')[1];
    }
  }
  return { commands, npmShortcuts };
}

export function loadCommands() {
  const yaml = readFileSync(commandsPath, "utf8");
  return parseCommandsYaml(yaml);
}

function parseFrontmatter(text) {
  text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!text.startsWith("---")) return {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};

  const block = match[1];
  const fm = {};

  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (nameMatch) {
    fm.name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  const inlineDesc = block.match(/^description:\s*(.+)$/m);
  if (inlineDesc && !/^>-?\s*$/.test(inlineDesc[1].trim())) {
    fm.description = inlineDesc[1].trim().replace(/^["']|["']$/g, "");
  } else {
    const multiDesc = block.match(/^description:\s*>-?\s*\r?\n((?:[ \t]+.+\r?\n?)+)/m);
    if (multiDesc) {
      fm.description = multiDesc[1]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ");
    }
  }

  return fm;
}

export function buildSkillIndex(root = repoRoot) {
  const index = new Map();
  const skillsRoot = join(root, ".github/skills");

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (name !== "SKILL.md") continue;
      const fm = parseFrontmatter(readFileSync(p, "utf8"));
      const rel = p.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").length + 1);
      const folder = dirname(p).split(/[/\\]/).pop();
      if (fm.name) index.set(fm.name, rel);
      index.set(folder, rel);
    }
  }

  walk(skillsRoot);
  return index;
}

function skillPath(skill, skillIndex) {
  return skillIndex.get(skill) ?? `.github/skills/**/${skill}/SKILL.md`;
}

function claudeAction(cmd, skillIndex) {
  if (!cmd.skill && cmd.npm) {
    return `Run \`npm run ${cmd.npm}\` — ${cmd.description.toLowerCase()}`;
  }
  if (cmd.type === "agent") {
    return `.github/agents/${cmd.skill}.agent.md`;
  }
  const path = skillPath(cmd.skill, skillIndex);
  if (cmd.skill === "hyperion-ops" && cmd.npm) {
    return `\`${path}\` → \`npm run ${cmd.npm}\``;
  }
  return `\`${path}\``;
}

function cursorUserSays(cmd) {
  const alias = CURSOR_ALIASES[cmd.phrase];
  if (alias) return `\`${cmd.phrase}\` or ${alias}`;
  return `\`${cmd.phrase}\``;
}

function cursorAction(cmd) {
  if (!cmd.skill && cmd.npm) return `\`npm run ${cmd.npm}\` + summarize`;
  if (cmd.type === "agent") return `\`${cmd.skill}\` agent`;
  if (cmd.skill === "hyperion-ops" && cmd.npm) {
    return `\`hyperion-ops\` → \`npm run ${cmd.npm}\``;
  }
  return `\`${cmd.skill}\``;
}

function copilotNeed(cmd) {
  const labels = {
    "/help": "List Hyperion shortcuts",
    "/setup": "Full Hyperion setup",
    "/doctor": "Sync / doctor / validate cards",
    "/sync": "Sync / doctor / validate cards",
  };
  if (labels[cmd.phrase]) return labels[cmd.phrase];
  return cmd.description.charAt(0).toUpperCase() + cmd.description.slice(1);
}

function copilotAction(cmd) {
  if (!cmd.skill && cmd.npm) return `\`npm run ${cmd.npm}\``;
  if (cmd.type === "agent") return `\`${cmd.skill}\` agent`;
  if (cmd.skill === "hyperion-ops" && cmd.npm) {
    return `\`hyperion-ops\` — runs \`npm run ${cmd.npm}\``;
  }
  return `\`${cmd.skill}\` — or user says \`${cmd.phrase}\``;
}

export function buildClaudeRows(commands, skillIndex) {
  return commands.map((cmd) => `| ${cmd.phrase} | ${claudeAction(cmd, skillIndex)} |`);
}

export function buildCursorRows(commands) {
  return commands.map((cmd) => `| ${cursorUserSays(cmd)} | ${cursorAction(cmd)} |`);
}

export function buildCopilotRows(commands) {
  const rows = [];
  let hyperionOpsDone = false;

  for (const cmd of commands) {
    if (cmd.phrase === "/help") continue;

    if (cmd.skill === "hyperion-ops") {
      if (hyperionOpsDone) continue;
      hyperionOpsDone = true;
      rows.push(
        "| **Sync / doctor / validate cards** | `hyperion-ops` — runs `npm run hyperion:sync`, `hyperion:doctor` |"
      );
      continue;
    }

    const need = copilotNeed(cmd);
    const action = copilotAction(cmd);
    const needCell = need.startsWith("Full ") ? `**${need}**` : need;
    rows.push(`| ${needCell} | ${action} |`);
  }

  return rows;
}

export function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n");
}

export function buildSkillsSection(root = repoRoot) {
  const lines = ["Skills live in `.github/skills/` organized by category:", ""];
  for (const cat of SKILL_CATEGORIES) {
    const dir = join(root, ".github/skills", cat);
    let names = [];
    try {
      names = readdirSync(dir)
        .filter((n) => statSync(join(dir, n)).isDirectory())
        .sort();
    } catch {
      names = [];
    }
    lines.push(`- **${cat}/** — ${names.join(", ")}`);
  }
  lines.push("");
  lines.push(
    "When the user asks for any of these capabilities, read the corresponding `SKILL.md` and follow its instructions exactly."
  );
  return lines.join("\n");
}

const AGENT_DESCRIPTIONS = {
  "spec-review": "gate card/spec before coding (`/spec-review`)",
  "implementation-plan": "phased implementation plan (`/implement`)",
  "implementation-executor": "execute approved plan phases (`/execute`)",
  "audit-runner": "orchestrated 6-dimension audit (`/audit-run`)",
  release: "changelog, version, tag (`/release`)",
  mentoring: "for teaching/explaining (`/mentor`)",
  "pr-reviewer": "review open PR diff + tests (`/pr-review`)",
  migration: "adapt Hyperion to existing repo (`/migrate`)",
};

export function buildAgentsSection(root = repoRoot) {
  const agentsDir = join(root, ".github/agents");
  const files = readdirSync(agentsDir)
    .filter((f) => f.endsWith(".agent.md"))
    .sort();
  const lines = files.map((f) => {
    const name = f.replace(".agent.md", "");
    const desc = AGENT_DESCRIPTIONS[name] ?? "see agent file";
    return `- \`.github/agents/${f}\` — ${desc}`;
  });
  lines.push("");
  lines.push("See `.github/agents/README.md` for catalog and recommended flow.");
  return lines.join("\n");
}

export function replaceMarkedSection(content, rows, start = MARKER_START, end = MARKER_END) {
  const block = `${start}\n${rows.join("\n")}\n${end}`;
  const pattern = new RegExp(
    `${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
  );
  if (!pattern.test(content)) {
    throw new Error(`${start} markers not found`);
  }
  return content.replace(pattern, block);
}

export function replaceTextSection(content, text, start, end) {
  const block = `${start}\n${text}\n${end}`;
  const pattern = new RegExp(
    `${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
  );
  if (!pattern.test(content)) {
    throw new Error(`${start} markers not found`);
  }
  return content.replace(pattern, block);
}

export function buildHelpContent(commands, npmShortcuts) {
  const agentRows = commands
    .filter((c) => c.type === "agent" || (c.skill && AGENT_PHRASES_EXTRA.has(c.phrase)))
    .map((c) => {
      const label = c.type === "agent" ? `${c.skill} agent` : c.skill;
      return [`${c.phrase}`, `${label} — ${c.description}`];
    });

  return `import { log } from "./lib.mjs";

// AUTO-GENERATED from .github/commands.yml — run: npm run hyperion:generate-rules

const sections = [
  {
    title: "Hyperion — one-liners (npm)",
    rows: ${JSON.stringify(npmShortcuts.map((s) => [s.cmd.replace("npm run ", ""), s.desc]))},
  },
  {
    title: "Agent phrases (no terminal — preferred)",
    rows: ${JSON.stringify(agentRows)},
  },
];

function printTable(title, rows) {
  log("", "");
  log("", title);
  log("", "─".repeat(Math.min(title.length + 4, 60)));
  const colWidth = Math.max(...rows.map((r) => r[0].length), 20);
  for (const [cmd, desc] of rows) {
    log("", \`  \${cmd.padEnd(colWidth)}  \${desc}\`);
  }
}

for (const section of sections) {
  printTable(section.title, section.rows);
}

log("", "");
log("", "Docs: .github/docs/reference/comandos-rapidos.md");
log("", "Claude Code: CLAUDE.md · Cursor: .cursor/rules/hyperion.mdc");
`;
}

export const RUNTIME_TARGETS = [
  {
    path: join(repoRoot, "CLAUDE.md"),
    buildRows: (commands, skillIndex) => buildClaudeRows(commands, skillIndex),
    syncCatalog: true,
  },
  {
    path: join(repoRoot, ".cursor/rules/hyperion.mdc"),
    buildRows: (commands) => buildCursorRows(commands),
    syncCatalog: true,
  },
  {
    path: join(repoRoot, ".github/copilot-instructions.md"),
    buildRows: (commands) => buildCopilotRows(commands),
    syncCatalog: true,
  },
  {
    // Windsurf's classic, still-supported root rules file (the newer
    // .windsurf/rules/*.md directory format also exists, but a single
    // file matches this kit's convention for every other runtime target).
    path: join(repoRoot, ".windsurfrules"),
    buildRows: (commands) => buildCursorRows(commands),
    syncCatalog: true,
  },
  {
    // Zed's own top-priority rules filename (it also reads CLAUDE.md and
    // .github/copilot-instructions.md, both already generated above, but
    // `.rules` sits first in Zed's own lookup order).
    path: join(repoRoot, ".rules"),
    buildRows: (commands) => buildCursorRows(commands),
    syncCatalog: true,
  },
];
