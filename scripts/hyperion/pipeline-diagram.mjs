/**
 * Pipeline diagrams (Mermaid flowchart + PlantUML) from GitHub Actions workflows.
 *
 * Sources: ci.gates (rendered through product-ci-render, so the diagram always
 * matches what pipeline-apply would write) and every existing
 * .github/workflows/*.yml — Hyperion-generated or not.
 *
 * CLI: [--source all|gates|workflows] [--format both|mermaid|puml] [--write] [--out dir]
 *      [--no-steps] [--preset minimal|balanced|strict] [--gates-file draft.yml] [--lang <tag>]
 * Without --write prints Markdown (```mermaid / ```plantuml blocks) to stdout.
 * Labels and legend follow `locale` in project.yml (--lang overrides); job/step names stay as written.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";
import { normalizeTag, resolveLanguages, t } from "./i18n.mjs";

const label = (key, { lang = "en", root = null } = {}) => t(`diagram.${key}`, {}, lang, { root });

const SETUP_STEP = /^(Checkout|Setup |Enable corepack|Install (dependencies|CI tools|golangci|cargo|uv|Poetry|Pipenv)|Rust (components|\d)|Login to|Image name|Metadata|Paths filter|Prepare \.env|Default markdownlint config|Pub get)/i;

const SETUP_USES = /^(actions\/(checkout|setup-[a-z]+|cache|download-artifact)|pnpm\/action-setup|oven-sh\/setup-bun|subosito\/flutter-action|dtolnay\/rust-toolchain|astral-sh\/setup-uv|docker\/(setup-[a-z]+-action|login-action|metadata-action)|ruby\/setup-ruby|gradle\/actions\/setup-gradle)/;
const SETUP_RUN = /^(npm (ci|install)|pnpm install|yarn( install)?|bun install|pip install|poetry install|uv sync|go mod download|bundle install|flutter pub get|dart pub get|corepack enable)\b/;

const toId = (s) => String(s).replace(/[^A-Za-z0-9_]/g, "_");
const plainExpr = (s) => String(s ?? "").replace(/\$\{\{\s*(.*?)\s*\}\}/g, "$1");

function listify(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function triggersOf(on) {
  if (!on) return [];
  if (typeof on === "string") return [{ name: on, detail: "" }];
  if (Array.isArray(on)) return on.map((n) => ({ name: String(n), detail: "" }));
  return Object.entries(on).map(([name, cfg]) => {
    const parts = [];
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
      if (cfg.branches) parts.push(listify(cfg.branches).join(", "));
      if (cfg.tags) parts.push(`tags ${listify(cfg.tags).join(", ")}`);
      if (cfg.types) parts.push(listify(cfg.types).join(", "));
      if (cfg["paths-ignore"]) parts.push("paths-ignore");
      if (cfg.paths) parts.push("paths filter");
    }
    if (Array.isArray(cfg)) parts.push(cfg.map((c) => c?.cron || JSON.stringify(c)).join(", "));
    return { name, detail: parts.filter(Boolean).join(" · ") };
  });
}

/** Short tags describing when a job runs, read from its `if:`. */
export function whenTags(cond, opts = {}) {
  const c = String(cond || "");
  const keys = [];
  const affected = /event_name\s*!=\s*'pull_request'\s*\|\|\s*needs\.changes\.outputs/.test(c);
  if (affected) keys.push("affected");
  else {
    if (/event_name\s*==\s*'pull_request'/.test(c)) keys.push("prOnly");
    if (/event_name\s*!=\s*'pull_request'/.test(c)) keys.push("notOnPr");
    if (/needs\.changes\.outputs/.test(c)) keys.push("ifChanged");
  }
  if (/event_name\s*==\s*'push'/.test(c)) keys.push("pushOnly");
  if (/event_name\s*==\s*'schedule'/.test(c)) keys.push("schedule");
  if (/refs\/tags\//.test(c)) keys.push("tags");
  if (/\bfailure\(\)/.test(c)) keys.push("onFailure");
  else if (/\balways\(\)/.test(c)) keys.push("always");
  return keys.map((k) => label(`when.${k}`, opts));
}

/**
 * @param {object} doc parsed workflow
 * @returns {{ title: string, file: string|null, triggers: {name:string,detail:string}[], jobs: object[] }}
 */
export function graphFromWorkflow(doc, { file = null, title = null, lang = "en", root = null } = {}) {
  const jobsObj = doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  const jobs = Object.entries(jobsObj).map(([id, j]) => {
    const steps = (j?.steps || [])
      .filter((s) => !(s?.uses && SETUP_USES.test(s.uses)) && !(!s?.name && s?.run && SETUP_RUN.test(String(s.run).trim())))
      .map((s) => {
        let name = s?.name ? plainExpr(s.name) : s?.uses ? s.uses.split("@")[0] : String(s?.run || "").split("\n")[0].slice(0, 40);
        const warn = s?.["continue-on-error"] === true || / \(warn\)$/.test(name);
        name = name.replace(/ \(warn\)$/, "");
        return { name, warn };
      })
      .filter((s) => s.name && !SETUP_STEP.test(s.name));
    const matrix = j?.strategy?.matrix && typeof j.strategy.matrix === "object"
      ? Object.entries(j.strategy.matrix)
          .filter(([k]) => !["include", "exclude"].includes(k))
          .map(([k, v]) => `${k}: ${listify(v).join(", ")}`)
      : [];
    const runsOn = plainExpr(Array.isArray(j?.["runs-on"]) ? j["runs-on"].join(", ") : j?.["runs-on"] || "");
    return {
      id,
      name: plainExpr(j?.name || id),
      needs: listify(j?.needs),
      when: whenTags(j?.if, { lang, root }),
      warn: j?.["continue-on-error"] === true,
      publish: j?.permissions?.packages === "write" || j?.permissions?.["id-token"] === "write" || /deploy|publish|release/i.test(id),
      notify: /notif/i.test(id),
      reusable: Boolean(j?.uses),
      matrix,
      services: j?.services ? Object.keys(j.services) : [],
      runsOn: runsOn && !/^ubuntu-latest$/.test(runsOn) && !/^matrix\./.test(runsOn) ? runsOn : "",
      steps,
    };
  });
  return { title: title || doc?.name || file || "Workflow", file, triggers: triggersOf(doc?.on ?? doc?.[true]), jobs };
}

export function graphFromWorkflowText(text, opts = {}) {
  return graphFromWorkflow(load(text), opts);
}

function jobClass(j) {
  if (j.notify) return "notify";
  if (j.publish) return "publish";
  if (j.warn) return "warn";
  return "block";
}

function jobLines(j, { steps = true, perLine = 3, lang = "en", root = null } = {}) {
  const opts = { lang, root };
  const meta = [
    j.when.length ? j.when.join(" · ") : null,
    j.matrix.length ? `${label("job.matrix", opts)} ${j.matrix.join("; ")}` : null,
    j.services.length ? `${label("job.services", opts)}: ${j.services.join(", ")}` : null,
    j.runsOn ? `runs-on: ${j.runsOn}` : null,
    j.warn ? label("job.warn", opts) : null,
  ].filter(Boolean);
  const stepLines = [];
  if (steps) {
    const names = j.steps.map((s) => `${s.name}${s.warn ? " ⚠" : ""}`);
    for (let i = 0; i < names.length; i += perLine) stepLines.push(names.slice(i, i + perLine).join(" · "));
  }
  return { meta, stepLines };
}

const mmd = (s) => String(s).replace(/"/g, "#quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MERMAID_CLASSES = [
  "  classDef trigger fill:#E3F2FD,stroke:#1565C0,color:#0D47A1",
  "  classDef block fill:#FFEBEE,stroke:#C62828,color:#212121",
  "  classDef warn fill:#FFF8E1,stroke:#F9A825,color:#212121,stroke-dasharray:5 3",
  "  classDef publish fill:#F3E5F5,stroke:#6A1B9A,color:#212121",
  "  classDef notify fill:#F5F5F5,stroke:#616161,color:#212121",
];

const LEGEND_KEYS = ["block", "warn", "publish", "notify", "warnStep"];

/** Legend entries in the requested language. */
export function legendParts(opts = {}) {
  return LEGEND_KEYS.map((k) => label(`legend.${k}`, opts));
}

/** Mermaid flowchart of one workflow graph. */
export function toMermaid(graph, { steps = true, direction = "LR", lang = "en", root = null } = {}) {
  const opts = { lang, root };
  const out = ["---", `title: ${mmd(graph.title)}`, "---", `flowchart ${direction}`];
  out.push(`  %% ${legendParts(opts).join(" · ")}`);
  const trig = graph.triggers.map((tr) => mmd(tr.detail ? `${tr.name}: ${tr.detail}` : tr.name));
  out.push(`  triggers(["<b>${mmd(label("triggers", opts))}</b><br/>${trig.join("<br/>") || "—"}"]):::trigger`);
  const ids = new Set(graph.jobs.map((j) => j.id));
  for (const j of graph.jobs) {
    const { meta, stepLines } = jobLines(j, { steps, ...opts });
    const text = [`<b>${mmd(j.name)}</b>`, ...meta.map((m) => `<i>${mmd(m)}</i>`), ...stepLines.map(mmd)].join("<br/>");
    out.push(`  j_${toId(j.id)}["${text}"]:::${jobClass(j)}`);
  }
  for (const j of graph.jobs) {
    const needs = j.needs.filter((n) => ids.has(n));
    if (!needs.length) out.push(`  triggers --> j_${toId(j.id)}`);
    for (const n of needs) out.push(`  j_${toId(n)} --> j_${toId(j.id)}`);
  }
  out.push(...MERMAID_CLASSES);
  return out.join("\n");
}

// ASCII only: plantuml.jar reads sources in the platform charset (cp1252 on Windows) unless -charset is passed,
// so other characters (accents in translated labels) become &#NNNN; entities.
export const puml = (s) =>
  Array.from(
    String(s)
      .replace(/"/g, "'")
      .replace(/→/g, "->")
      .replace(/[—–]/g, "-")
      .replace(/ ⚠/g, " (warn)")
      .replace(/⚠/g, "(warn)")
      .replace(/ · /g, ", ")
      .replace(/[\x00-\x1F\x7F]/g, " "),
  )
    .map((ch) => (ch.codePointAt(0) > 0x7e ? `&#${ch.codePointAt(0)};` : ch))
    .join("");

/** PlantUML (component-style) diagram of one workflow graph. */
export function toPlantUml(graph, { steps = true, lang = "en", root = null } = {}) {
  const opts = { lang, root };
  const out = [
    "@startuml",
    `title ${puml(graph.title)}`,
    "left to right direction",
    "skinparam backgroundColor white",
    "skinparam shadowing false",
    "skinparam defaultFontName Arial",
    "skinparam defaultFontSize 12",
    "skinparam roundcorner 8",
    "skinparam arrowColor #555555",
    "skinparam arrowThickness 1.5",
    "skinparam rectangle {",
    "  BackgroundColor<<block>> #FFEBEE",
    "  BorderColor<<block>> #C62828",
    "  BackgroundColor<<warn>> #FFF8E1",
    "  BorderColor<<warn>> #F9A825",
    "  BorderStyle<<warn>> dashed",
    "  BackgroundColor<<publish>> #F3E5F5",
    "  BorderColor<<publish>> #6A1B9A",
    "  BackgroundColor<<notify>> #F5F5F5",
    "  BorderColor<<notify>> #616161",
    "}",
    "skinparam card {",
    "  BackgroundColor #E3F2FD",
    "  BorderColor #1565C0",
    "}",
    "hide stereotype",
  ];
  const trig = graph.triggers.map((tr) => puml(tr.detail ? `${tr.name}: ${tr.detail}` : tr.name));
  out.push(`card "**${puml(label("triggers", opts))}**\\n----\\n${trig.join("\\n") || "-"}" as triggers`);
  const ids = new Set(graph.jobs.map((j) => j.id));
  for (const j of graph.jobs) {
    const { meta, stepLines } = jobLines(j, { steps, perLine: 1, ...opts });
    const body = [...meta.map((m) => `//${puml(m)}//`), ...(stepLines.length ? ["----", ...stepLines.map(puml)] : [])];
    out.push(`rectangle "**${puml(j.name)}**${body.length ? `\\n${body.join("\\n")}` : ""}" <<${jobClass(j)}>> as j_${toId(j.id)}`);
  }
  for (const j of graph.jobs) {
    const needs = j.needs.filter((n) => ids.has(n));
    if (!needs.length) out.push(`triggers --> j_${toId(j.id)}`);
    for (const n of needs) out.push(`j_${toId(n)} --> j_${toId(j.id)}`);
  }
  out.push("legend right", ...legendParts(opts).map(puml), "endlegend", "@enduml");
  return out.join("\n");
}

/** One diagram with every workflow as a subgraph (job names only). */
export function overviewMermaid(graphs, opts = {}) {
  const out = ["---", `title: ${mmd(label("overview", opts))}`, "---", "flowchart LR", `  %% ${legendParts(opts).join(" · ")}`];
  graphs.forEach((g, gi) => {
    const p = `w${gi}_`;
    out.push(`  subgraph ${p}wf["${mmd(path.basename(g.file || g.title))}"]`);
    out.push(`    ${p}t(["${mmd(g.triggers.map((t) => t.name).join(", ") || "—")}"]):::trigger`);
    const ids = new Set(g.jobs.map((j) => j.id));
    for (const j of g.jobs) out.push(`    ${p}${toId(j.id)}["${mmd(j.name)}"]:::${jobClass(j)}`);
    for (const j of g.jobs) {
      const needs = j.needs.filter((n) => ids.has(n));
      if (!needs.length) out.push(`    ${p}t --> ${p}${toId(j.id)}`);
      for (const n of needs) out.push(`    ${p}${toId(n)} --> ${p}${toId(j.id)}`);
    }
    out.push("  end");
  });
  out.push(...MERMAID_CLASSES);
  return out.join("\n");
}

export function overviewPlantUml(graphs, opts = {}) {
  const out = ["@startuml", `title ${puml(label("overview", opts))}`, "left to right direction", "skinparam shadowing false", "skinparam defaultFontName Arial", "skinparam roundcorner 8"];
  graphs.forEach((g, gi) => {
    const p = `w${gi}_`;
    out.push(`package "${puml(path.basename(g.file || g.title))}" {`);
    out.push(`  card "${puml(g.triggers.map((t) => t.name).join(", ") || "-")}" as ${p}t #E3F2FD`);
    const ids = new Set(g.jobs.map((j) => j.id));
    const color = { block: "#FFEBEE", warn: "#FFF8E1", publish: "#F3E5F5", notify: "#F5F5F5" };
    for (const j of g.jobs) out.push(`  rectangle "${puml(j.name)}" as ${p}${toId(j.id)} ${color[jobClass(j)]}`);
    for (const j of g.jobs) {
      const needs = j.needs.filter((n) => ids.has(n));
      if (!needs.length) out.push(`  ${p}t --> ${p}${toId(j.id)}`);
      for (const n of needs) out.push(`  ${p}${toId(n)} --> ${p}${toId(j.id)}`);
    }
    out.push("}");
  });
  out.push("@enduml");
  return out.join("\n");
}

/** Every workflow under .github/workflows (parse errors reported, not thrown). */
export function readWorkflowGraphs(root, { lang = "en" } = {}) {
  const dir = path.join(root, ".github", "workflows");
  if (!fs.existsSync(dir)) return { graphs: [], errors: [] };
  const graphs = [];
  const errors = [];
  for (const name of fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
    const rel = `.github/workflows/${name}`;
    try {
      const doc = load(fs.readFileSync(path.join(dir, name), "utf8"));
      if (doc?.jobs) graphs.push(graphFromWorkflow(doc, { file: rel, title: doc.name ? `${doc.name} (${name})` : name, lang, root }));
    } catch (e) {
      errors.push(`${rel}: ${e.message.split("\n")[0]}`);
    }
  }
  return { graphs, errors };
}

/** Diagram of what ci.gates renders (null when there are no gates). */
export async function gatesGraph(root, { gates, kitRootRel = "", defaultBranch = "main", lang = "en" }) {
  if (!gates) return null;
  const { renderProductCiForRepo, readGatesHash } = await import("./product-ci-render.mjs");
  const { content } = renderProductCiForRepo(root, { gates, kitRootRel, defaultBranch });
  const current = (() => {
    try {
      return fs.readFileSync(path.join(root, ".github", "workflows", "hyperion-product-ci.yml"), "utf8");
    } catch {
      return null;
    }
  })();
  return {
    graph: graphFromWorkflowText(content, { file: "ci.gates", title: "ci.gates → hyperion-product-ci.yml", lang, root }),
    upToDate: Boolean(current) && readGatesHash(current) === readGatesHash(content),
  };
}

/**
 * Build every requested diagram.
 * @returns {Promise<{ diagrams: {slug:string,title:string,mermaid?:string,puml?:string}[], notes: string[] }>}
 */
export async function buildPipelineDiagrams(root, { source = "all", format = "both", steps = true, gates = null, kitRootRel = "", defaultBranch = "main", lang = "en" } = {}) {
  const diagrams = [];
  const notes = [];
  const opts = { lang, root };
  const emit = (slug, title, graph) =>
    diagrams.push({
      slug,
      title,
      ...(format !== "puml" ? { mermaid: toMermaid(graph, { steps, ...opts }) } : {}),
      ...(format !== "mermaid" ? { puml: toPlantUml(graph, { steps, ...opts }) } : {}),
    });

  let skipProductCi = false;
  if (source !== "workflows") {
    const g = await gatesGraph(root, { gates, kitRootRel, defaultBranch, lang });
    if (g) {
      emit("pipeline-gates", g.graph.title, g.graph);
      skipProductCi = g.upToDate;
      if (!g.upToDate) notes.push("hyperion-product-ci.yml differs from ci.gates (or is missing) — pipeline-gates shows what --refresh-gates would write.");
    } else if (source === "gates") {
      notes.push("No ci.gates in project.yml — run /pipeline (or pass --preset / --gates-file).");
    }
  }
  if (source !== "gates") {
    const { graphs, errors } = readWorkflowGraphs(root, { lang });
    for (const e of errors) notes.push(`Skipped (YAML error) ${e}`);
    const shown = graphs.filter((g) => !(skipProductCi && g.file?.endsWith("hyperion-product-ci.yml")));
    if (skipProductCi) notes.push("hyperion-product-ci.yml matches ci.gates — drawn once as pipeline-gates.");
    for (const g of shown) emit(`workflow-${path.basename(g.file).replace(/\.ya?ml$/i, "")}`, g.title, g);
    if (graphs.length > 1) {
      diagrams.push({
        slug: "pipeline-overview",
        title: label("overviewAll", opts),
        ...(format !== "puml" ? { mermaid: overviewMermaid(graphs, opts) } : {}),
        ...(format !== "mermaid" ? { puml: overviewPlantUml(graphs, opts) } : {}),
      });
    }
    if (!graphs.length && !errors.length) notes.push("No workflows under .github/workflows.");
  }
  return { diagrams, notes, lang };
}

/** Markdown with ```mermaid blocks (GitHub renders them) and links to the .puml sources. */
export function diagramsMarkdown({ diagrams, notes, lang = "en" }, { withPuml = false, root = null } = {}) {
  const opts = { lang, root };
  const out = [
    `# ${label("readme.title", opts)}`,
    "",
    label("readme.generated", opts),
    "",
    `${label("readme.legend", opts)}: ${legendParts(opts).join(" · ")}.`,
    "",
  ];
  for (const n of notes) out.push(`> ${n}`, "");
  for (const d of diagrams) {
    out.push(`## ${d.title}`, "");
    if (d.mermaid) out.push("```mermaid", d.mermaid, "```", "");
    if (d.puml) out.push(withPuml ? ["```plantuml", d.puml, "```"].join("\n") : `${label("readme.pumlSource", opts)}: [${d.slug}.puml](${d.slug}.puml)`, "");
  }
  return out.join("\n");
}

/** project.yml outputs.diagrams > docs.diagrams > .github/diagrams */
export function diagramsDir(root, projectText) {
  let doc = null;
  try {
    doc = projectText ? load(projectText) : null;
  } catch {
    doc = null;
  }
  const rel = doc?.outputs?.diagrams || doc?.docs?.diagrams || ".github/diagrams";
  return path.resolve(root, rel);
}

async function main() {
  const { resolveHyperionPaths } = await import("./paths.mjs");
  const { detectWorkflowBaseBranch, readCiGatesFromProjectYml } = await import("./pipeline-lib.mjs");
  const root = process.cwd();
  const paths = resolveHyperionPaths(root);
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const source = flag("--source") || "all";
  const format = flag("--format") || "both";
  if (!["all", "gates", "workflows"].includes(source) || !["both", "mermaid", "puml"].includes(format)) {
    console.error("Usage: pipeline-diagram [--source all|gates|workflows] [--format both|mermaid|puml] [--write] [--out dir] [--no-steps] [--preset name] [--gates-file draft.yml] [--lang <tag>]");
    process.exit(2);
  }
  const projectText = (() => {
    try {
      return fs.readFileSync(paths.projectYmlPath, "utf8");
    } catch {
      return "";
    }
  })();
  let gates = await readCiGatesFromProjectYml(projectText);
  const gatesFile = flag("--gates-file");
  if (gatesFile) {
    const doc = load(fs.readFileSync(path.resolve(root, gatesFile), "utf8")) || {};
    gates = doc?.ci?.gates || doc?.gates || doc;
  }
  const preset = flag("--preset");
  if (preset) {
    const { PRESET_NAMES } = await import("./pipeline-gates.mjs");
    if (!PRESET_NAMES.includes(preset)) {
      console.error(`Unknown preset "${preset}" — use ${PRESET_NAMES.join(", ")}`);
      process.exit(2);
    }
    gates = { ...(gates || {}), preset };
  }

  const result = await buildPipelineDiagrams(root, {
    source,
    format,
    steps: !argv.includes("--no-steps"),
    gates,
    kitRootRel: paths.kitRootRel || "",
    defaultBranch: detectWorkflowBaseBranch(root).branch,
    lang: normalizeTag(flag("--lang")) || resolveLanguages(root).primary,
  });

  if (!argv.includes("--write")) {
    console.log(diagramsMarkdown(result, { withPuml: true, root }));
    console.log("\nNothing written. Save under the diagrams folder with --write.");
    return;
  }
  const outDir = flag("--out") ? path.resolve(root, flag("--out")) : path.join(diagramsDir(root, projectText), "Pipeline");
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (name, text) => {
    fs.writeFileSync(path.join(outDir, name), `${text}\n`);
    written.push(path.relative(root, path.join(outDir, name)).replace(/\\/g, "/"));
  };
  for (const d of result.diagrams) {
    if (d.mermaid) write(`${d.slug}.mmd`, d.mermaid);
    if (d.puml) write(`${d.slug}.puml`, d.puml);
  }
  if (result.diagrams.length) write("README.md", diagramsMarkdown(result, { root }));
  for (const n of result.notes) console.log(`note: ${n}`);
  console.log(written.length ? `Wrote ${written.length} file(s):\n  ${written.join("\n  ")}` : "No diagrams to write.");
  console.log("Export PNG: npx --yes @mermaid-js/mermaid-cli -i <file>.mmd -o <file>.png");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
