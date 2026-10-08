import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPipelineDiagrams,
  diagramsDir,
  diagramsMarkdown,
  graphFromWorkflowText,
  overviewMermaid,
  puml,
  toMermaid,
  toPlantUml,
  whenTags,
} from "./pipeline-diagram.mjs";

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

const GENERIC = `name: Deploy
on:
  push:
    branches: [main]
    tags: ["v*"]
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    services:
      postgres:
        image: postgres:16
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - name: Unit tests
        run: npm test
      - name: Lint "strict"
        run: npm run lint
        continue-on-error: true
  build:
    needs: test
    runs-on: windows-latest
    steps:
      - name: Build
        run: npm run build
  deploy:
    needs: [build]
    if: github.event_name == 'push'
    permissions:
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - name: Deploy \${{ github.ref_name }}
        run: ./deploy.sh
  report:
    needs: [deploy]
    if: \${{ failure() }}
    continue-on-error: true
    runs-on: ubuntu-latest
    steps:
      - run: echo failed
`;

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-diagram-"));
  write(root, "api/package.json", {
    scripts: { test: "jest", lint: "eslint .", "format:check": "prettier --check ." },
    devDependencies: { jest: "^29", eslint: "^9", prettier: "^3" },
  });
  write(root, "api/package-lock.json", "{}");
  write(root, "svc/go.mod", "module example.com/svc\n\ngo 1.22\n");
  write(root, ".github/workflows/deploy.yml", GENERIC);
  write(root, ".github/workflows/broken.yml", "jobs: [unclosed\n");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("graphFromWorkflow", () => {
  it("reads triggers, needs, matrix, services, runner, warn and setup filtering", () => {
    const g = graphFromWorkflowText(GENERIC, { file: "deploy.yml" });
    assert.equal(g.title, "Deploy");
    assert.deepEqual(g.triggers.map((t) => t.name), ["push", "workflow_dispatch"]);
    assert.match(g.triggers[0].detail, /main · tags v\*/);
    const byId = Object.fromEntries(g.jobs.map((j) => [j.id, j]));
    assert.deepEqual(byId.test.steps.map((s) => s.name), ["Unit tests", 'Lint "strict"']);
    assert.equal(byId.test.steps[1].warn, true);
    assert.deepEqual(byId.test.matrix, ["node: 20, 22"]);
    assert.deepEqual(byId.test.services, ["postgres"]);
    assert.equal(byId.build.runsOn, "windows-latest");
    assert.deepEqual(byId.build.needs, ["test"]);
    assert.equal(byId.deploy.publish, true);
    assert.deepEqual(byId.deploy.when, ["push only"]);
    assert.equal(byId.deploy.steps[0].name, "Deploy github.ref_name");
    assert.equal(byId.report.warn, true);
    assert.deepEqual(byId.report.when, ["on failure"]);
  });

  it("tags affected-only app jobs instead of calling them not-on-PR", () => {
    assert.deepEqual(
      whenTags("${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.api == 'true') }}"),
      ["on PR: only if this app changed"],
    );
    assert.deepEqual(whenTags("github.event_name == 'pull_request'"), ["PR only"]);
    assert.deepEqual(whenTags("${{ always() }}"), ["always"]);
  });
});

describe("toMermaid / toPlantUml", () => {
  const g = graphFromWorkflowText(GENERIC, { file: "deploy.yml" });

  it("emits a flowchart with trigger fan-out, needs edges and mode classes", () => {
    const m = toMermaid(g);
    assert.match(m, /^---\ntitle: Deploy\n---\nflowchart LR/);
    assert.match(m, /triggers --> j_test\n/);
    assert.match(m, /j_test --> j_build\n/);
    assert.match(m, /j_build --> j_deploy\n/);
    assert.match(m, /j_deploy\["[^\n]*"\]:::publish/);
    assert.match(m, /j_report\["[^\n]*"\]:::warn/);
    assert.match(m, /Lint #quot;strict#quot; ⚠/);
    assert.match(m, /classDef block /);
    assert.doesNotMatch(toMermaid(g, { steps: false }), /Unit tests/);
  });

  it("emits PlantUML with stereotypes, edges and a legend", () => {
    const p = toPlantUml(g);
    assert.match(p, /^@startuml\n/);
    assert.match(p, /@enduml$/);
    assert.match(p, /<<publish>> as j_deploy/);
    assert.match(p, /<<warn>> as j_report/);
    assert.match(p, /j_test --> j_build/);
    assert.match(p, /Lint 'strict' \(warn\)/);
    assert.match(p, /legend right\nred = block \(fails the run\)\namber dashed = warn\n/);
    assert.doesNotMatch(p, /[^\x00-\x7F]/, "ASCII only (plantuml.jar default charset on Windows)");
    assert.doesNotMatch(p, /"[^"\n]*"[^"\n]*"[^"\n]*" <</, "no unescaped quotes inside labels");
  });

  it("translates labels and legend; PlantUML stays ASCII via &#NNNN; entities", () => {
    const pt = graphFromWorkflowText(GENERIC, { file: "deploy.yml", lang: "pt-BR" });
    const report = pt.jobs.find((j) => j.id === "report");
    assert.deepEqual(report.when, ["quando falha"]);
    const m = toMermaid(pt, { lang: "pt-BR" });
    assert.match(m, /<b>Gatilhos<\/b>/);
    assert.match(m, /vermelho = bloqueia \(falha o run\)/);
    const p = toPlantUml(pt, { lang: "pt-BR" });
    assert.match(p, /legend right\nvermelho = bloqueia \(falha o run\)\n&#226;mbar tracejado = aviso\n/);
    assert.match(p, /\/\/quando falha\/\//);
    assert.doesNotMatch(p, /[^\x00-\x7F]/);
    assert.equal(puml("Saída — ação ⚠"), "Sa&#237;da - a&#231;&#227;o (warn)");
    assert.equal(puml("emoji 🚀"), "emoji &#128640;");
    assert.match(toMermaid(graphFromWorkflowText(GENERIC, { lang: "es" }), { lang: "es" }), /<b>Disparadores<\/b>/);
  });

  it("overview keeps workflows in separate subgraphs", () => {
    const m = overviewMermaid([g, { ...g, file: "other.yml" }]);
    assert.match(m, /subgraph w0_wf\["deploy.yml"\]/);
    assert.match(m, /subgraph w1_wf\["other.yml"\]/);
    assert.match(m, /w1_test --> w1_build/);
  });
});

describe("buildPipelineDiagrams", () => {
  it("draws ci.gates plus existing workflows, reports YAML errors", async () => {
    const { diagrams, notes } = await buildPipelineDiagrams(root, { gates: { preset: "balanced" } });
    const slugs = diagrams.map((d) => d.slug);
    assert.deepEqual(slugs, ["pipeline-gates", "workflow-deploy"]);
    const gates = diagrams[0];
    assert.match(gates.mermaid, /j_app_api\[/);
    assert.match(gates.mermaid, /on PR: only if this app changed/);
    assert.match(gates.puml, /@startuml/);
    assert.ok(notes.some((n) => /broken\.yml/.test(n)));
    assert.ok(notes.some((n) => /differs from ci\.gates/.test(n)));
  });

  it("draws hyperion-product-ci.yml once when it matches ci.gates", async () => {
    const gates = { preset: "minimal" };
    const { renderProductCiForRepo } = await import("./product-ci-render.mjs");
    write(root, ".github/workflows/hyperion-product-ci.yml", renderProductCiForRepo(root, { gates }).content);
    const { diagrams, notes } = await buildPipelineDiagrams(root, { gates });
    const slugs = diagrams.map((d) => d.slug);
    assert.ok(slugs.includes("pipeline-gates"));
    assert.ok(!slugs.includes("workflow-hyperion-product-ci"));
    assert.ok(slugs.includes("pipeline-overview"));
    assert.ok(notes.some((n) => /drawn once/.test(n)));
    fs.rmSync(path.join(root, ".github/workflows/hyperion-product-ci.yml"));
  });

  it("honours source and format filters", async () => {
    const onlyWf = await buildPipelineDiagrams(root, { source: "workflows", format: "mermaid", gates: { preset: "minimal" } });
    assert.deepEqual(onlyWf.diagrams.map((d) => d.slug), ["workflow-deploy"]);
    assert.equal(onlyWf.diagrams[0].puml, undefined);
    const noGates = await buildPipelineDiagrams(root, { source: "gates", format: "puml" });
    assert.equal(noGates.diagrams.length, 0);
    assert.ok(noGates.notes.some((n) => /No ci\.gates/.test(n)));
  });

  it("markdown embeds mermaid and links the .puml", async () => {
    const md = diagramsMarkdown(await buildPipelineDiagrams(root, { source: "workflows" }));
    assert.match(md, /```mermaid\n---\ntitle: Deploy/);
    assert.match(md, /\[workflow-deploy\.puml\]\(workflow-deploy\.puml\)/);
    const es = diagramsMarkdown(await buildPipelineDiagrams(root, { source: "workflows", lang: "es" }));
    assert.match(es, /^# /);
    assert.doesNotMatch(es, /^# Pipeline diagrams/);
  });
});

describe("diagramsDir", () => {
  it("prefers outputs.diagrams, then docs.diagrams, then .github/diagrams", () => {
    assert.equal(diagramsDir("/r", "outputs:\n  diagrams: docs/arch\ndocs:\n  diagrams: x\n"), path.resolve("/r", "docs/arch"));
    assert.equal(diagramsDir("/r", "docs:\n  diagrams: doc/diagrams\n"), path.resolve("/r", "doc/diagrams"));
    assert.equal(diagramsDir("/r", ""), path.resolve("/r", ".github/diagrams"));
  });
});
