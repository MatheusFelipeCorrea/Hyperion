#!/usr/bin/env node
/**
 * Generate human skill catalog from commands.yml + catalog-meta.json + SKILL.md paths.
 * Run: npm run hyperion:skills-catalog
 * CI: npm run hyperion:skills-catalog -- --check
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillIndex, loadCommands } from "./commands-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const metaPath = join(root, ".github/skills/catalog-meta.json");
const outPt = join(root, ".github/docs/reference/catalogo-skills.md");
const outEn = join(root, ".github/docs/reference/skills-catalog.md");

const PHASE_ORDER = ["bootstrap", "plan", "deliver", "quality", "docs"];
const PHASE_LABEL = {
  pt: {
    bootstrap: "🧭 Bootstrap",
    plan: "📋 Planejamento",
    deliver: "⚡ Entrega",
    quality: "🔍 Qualidade",
    docs: "📚 Documentação",
  },
  en: {
    bootstrap: "🧭 Bootstrap",
    plan: "📋 Planning",
    deliver: "⚡ Delivery",
    quality: "🔍 Quality",
    docs: "📚 Documentation",
  },
};

const AGENTS = [
  { name: "migration", cmd: "/migrate", when_pt: "Adaptar kit a repo legado", when_en: "Adapt kit to legacy repo", output: ".github/plans/migrations/" },
  { name: "spec-review", cmd: "/spec-review", when_pt: "Gate de spec antes de codar", when_en: "Spec gate before coding", output: ".github/plans/reviews/" },
  { name: "implementation-plan", cmd: "/implement", when_pt: "Plano em fases", when_en: "Phased plan", output: ".github/plans/implementations/" },
  { name: "implementation-executor", cmd: "/execute", when_pt: "Executar fase + testes", when_en: "Run phase + tests", output: "Código no repo" },
  { name: "pr-reviewer", cmd: "/pr-review", when_pt: "Revisar PR aberto", when_en: "Review open PR", output: ".github/plans/reviews/pr-*" },
  { name: "audit-runner", cmd: "/audit-run", when_pt: "Auditoria orquestrada", when_en: "Orchestrated audit", output: ".github/audits/results/" },
  { name: "release", cmd: "/release", when_pt: "Changelog, tag, release", when_en: "Changelog, tag, release", output: "CHANGELOG.md + tag" },
  { name: "mentoring", cmd: "/mentor", when_pt: "Ensino socrático", when_en: "Socratic teaching", output: "*(chat)*" },
];

function loadMeta() {
  return JSON.parse(readFileSync(metaPath, "utf8"));
}

function commandBySkill(commands) {
  const map = new Map();
  for (const c of commands) {
    if (c.skill && !map.has(c.skill)) map.set(c.skill, c.phrase);
  }
  return map;
}

function listSkills(meta, skillIndex) {
  const rows = [];
  for (const [name, info] of Object.entries(meta)) {
    rows.push({
      name,
      phase: info.phase,
      when_pt: info.when_pt,
      when_en: info.when_en,
      output: info.output,
      skillPath: skillIndex.get(name) ?? `.github/skills/**/${name}/SKILL.md`,
    });
  }
  return rows;
}

function render(locale, meta, commands, skillIndex) {
  const cmdMap = commandBySkill(commands);
  const skills = listSkills(meta, skillIndex);
  const isPt = locale === "pt";

  const lines = [];
  lines.push(isPt ? "# 🧩 Catálogo de skills Hyperion" : "# 🧩 Hyperion skills catalog");
  lines.push("");
  lines.push('<p align="center">');
  lines.push(
    `  <img src="https://img.shields.io/badge/skills-${skills.length}-F5D76E?style=for-the-badge&labelColor=0B1220" alt="${skills.length} skills">`
  );
  lines.push(
    `  <img src="https://img.shields.io/badge/agents-${AGENTS.length}-F5D76E?style=for-the-badge&labelColor=0B1220" alt="${AGENTS.length} agents">`
  );
  if (isPt) {
    lines.push(
      '  <img src="https://img.shields.io/badge/áreas-5-2563EB?style=for-the-badge&labelColor=0B1220" alt="5 áreas">'
    );
  }
  lines.push("</p>");
  lines.push("");
  lines.push(
    isPt
      ? "Índice humano: **quando usar**, **comando**, **output**."
      : "Human index: **when**, **command**, **output**."
  );
  lines.push("");
  if (isPt) {
    lines.push("| Como estudar | Link |");
    lines.push("|--------------|------|");
    lines.push("| 🟢 Só os 6 comandos | [GETTING-STARTED.md](../../../GETTING-STARTED.md) |");
    lines.push("| 🗺️ Visão no hub | [README.md](../../../README.md#skills-por-área--o-que-fazem) |");
    lines.push("| 💬 Frases no chat | [comandos-rapidos.md](./comandos-rapidos.md) |");
    lines.push("| 📁 Onde grava | [skills-output-map.md](./skills-output-map.md) |");
    lines.push("");
    lines.push("**English:** [skills-catalog.md](./skills-catalog.md)");
    lines.push("");
    lines.push("Legenda de área: 🧭 Bootstrap · 📋 Planejamento · ⚡ Entrega · 🔍 Qualidade · 📚 Docs");
  } else {
    lines.push("| Study path | Link |");
    lines.push("|------------|------|");
    lines.push("| 🟢 Six commands | [GETTING-STARTED.md](../../../GETTING-STARTED.md) |");
    lines.push("| 🗺️ Hub overview | [README.md](../../../README.md) |");
    lines.push("| 💬 Chat phrases | [quick-commands-en.md](./quick-commands-en.md) |");
    lines.push("");
    lines.push(
      "**Português:** [catalogo-skills.md](./catalogo-skills.md) · Areas: 🧭 Bootstrap · 📋 Planning · ⚡ Delivery · 🔍 Quality · 📚 Docs"
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const phase of PHASE_ORDER) {
    const phaseSkills = skills.filter((s) => s.phase === phase).sort((a, b) => a.name.localeCompare(b.name));
    if (!phaseSkills.length) continue;
    lines.push(`## ${PHASE_LABEL[locale][phase]}`);
    lines.push("");
    lines.push(
      isPt
        ? "| Skill | Comando | Quando | Output | SKILL |"
        : "| Skill | Command | When | Output | SKILL |"
    );
    lines.push("|-------|---------|--------|--------|-------|");
    for (const s of phaseSkills) {
      const cmd = cmdMap.get(s.name) ?? "—";
      const when = isPt ? s.when_pt : s.when_en;
      const rel = s.skillPath.replace(/^\.github\//, "../../");
      lines.push(`| **${s.name}** | \`${cmd}\` | ${when} | ${s.output} | [SKILL.md](${rel}) |`);
    }
    lines.push("");
  }

  lines.push(isPt ? "## 🤖 Agents (fluxos longos)" : "## 🤖 Agents (long flows)");
  lines.push("");
  lines.push(isPt ? "| Agent | Comando | Quando | Output | Arquivo |" : "| Agent | Command | When | Output | File |");
  lines.push("|-------|---------|--------|--------|-------|");
  for (const a of AGENTS) {
    const when = isPt ? a.when_pt : a.when_en;
    const agentRel = `../../agents/${a.name}.agent.md`;
    lines.push(`| **${a.name}** | \`${a.cmd}\` | ${when} | ${a.output} | [agent](${agentRel}) |`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

const check = process.argv.includes("--check");
const meta = loadMeta();
const { commands } = loadCommands();
const skillIndex = buildSkillIndex(root);
const pt = render("pt", meta, commands, skillIndex);
const en = render("en", meta, commands, skillIndex);

if (check) {
  const existingPt = readFileSync(outPt, "utf8");
  const existingEn = readFileSync(outEn, "utf8");
  if (existingPt !== pt || existingEn !== en) {
    console.error("skills-catalog out of date — run: npm run hyperion:skills-catalog");
    process.exit(1);
  }
  console.log("skills-catalog OK (in sync)");
  process.exit(0);
}

writeFileSync(outPt, pt, "utf8");
writeFileSync(outEn, en, "utf8");
console.log(`skills-catalog OK → ${outPt.replace(/\\/g, "/")}`);
console.log(`skills-catalog OK → ${outEn.replace(/\\/g, "/")}`);
