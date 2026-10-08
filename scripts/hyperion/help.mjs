import { log } from "./lib.mjs";

// AUTO-GENERATED from .github/commands.yml — run: npm run hyperion:generate-rules

const sections = [
  {
    title: "Hyperion — one-liners (npm)",
    rows: [["hyperion:help","This reference"],["hyperion:doctor","Kit + cards health check"],["hyperion:setup -- --yes","Full bootstrap"],["hyperion:sync","Validate + sync cards"],["hyperion:cursor","Install .cursor/rules/ if partial kit copy"],["hyperion:pipeline-detect","Detect CI/CD and ci policy"],["hyperion:pipeline-plan","Dry-run Hyperion workflow install"],["hyperion:pipeline-apply -- --yes","Apply hyperion-* workflows"],["hyperion:pipeline-gates","Scan repo for CI gates (lint, format, coverage, audit, docker…) + interview questions"],["hyperion:pipeline-gates -- --preview","CI-minute estimate + diff of hyperion-product-ci.yml from ci.gates (writes nothing)"],["hyperion:pipeline-diagram -- --write","Pipeline diagram (Mermaid + PlantUML) from ci.gates + .github/workflows → diagrams/Pipeline/"],["hyperion:repo-detect","Detect test/lint/build commands for this repo"],["hyperion:phase-verify","Enforce /execute Verification (tests_result PASS)"],["hyperion:project-verify","Enforce project.yml after /migrate or /discover"],["hyperion:review-verify","Enforce PR review artifact after /pr-review"],["hyperion:cli -- doctor","Same as hyperion:doctor via unified CLI"],["./bin/hyperion doctor","CLI wrapper — Node 20+ or Docker fallback"],["hyperion:docker-build","Build local hyperion-cli Docker image"],["hyperion:upgrade","Check GitHub origin for kit updates (dry-run plan)"],["hyperion:upgrade -- --yes","Fetch origin + apply kit upgrade (preserve project.yml)"],["hyperion:upgrade -- --check","Exit 1 if origin is ahead of local pin"],["hyperion:upgrade -- --from <kit> --yes","Apply from local kit path (offline)"],["cards:watch","Auto-sync on save"],["cards:auto -- --dry-run","Preview two-way reconcile (board status/sprint ↔ markdown, duplicates, deletions)"]],
  },
  {
    title: "Agent phrases (no terminal — preferred)",
    rows: [["/setup","project-startup — Full guided setup"],["/doctor","hyperion-ops — Kit + cards health check"],["/sync","hyperion-ops — Validate + sync cards"],["/discover","project-discovery — Map repo, create project.yml"],["/migrate","migration agent — Adapt Hyperion to existing repo"],["/refine","card-refiner — Refine idea into cards"],["/audit","full-audit — Full audit (6 dimensions)"],["/review","code-review — Code review"],["/pr-review","pr-reviewer agent — Review open PR (diff + tests)"],["/implement","implementation-plan agent — Phased implementation plan"],["/execute","implementation-executor agent — Execute approved plan phase"],["/spec-review","spec-review agent — Gate card/spec before coding"],["/audit-run","audit-runner agent — Orchestrated 6-dimension audit"],["/release","release agent — Changelog, version, tag"],["/mentor","mentoring agent — Socratic teaching"],["/connect","integration-bridge — Jira/Azure/Linear/GitLab bridge"]],
  },
];

function printTable(title, rows) {
  log("", "");
  log("", title);
  log("", "─".repeat(Math.min(title.length + 4, 60)));
  const colWidth = Math.max(...rows.map((r) => r[0].length), 20);
  for (const [cmd, desc] of rows) {
    log("", `  ${cmd.padEnd(colWidth)}  ${desc}`);
  }
}

for (const section of sections) {
  printTable(section.title, section.rows);
}

log("", "");
log("", "Docs: .github/docs/reference/comandos-rapidos.md");
log("", "Claude Code: CLAUDE.md · Cursor: .cursor/rules/hyperion.mdc");
