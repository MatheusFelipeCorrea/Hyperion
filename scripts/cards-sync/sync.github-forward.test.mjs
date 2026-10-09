import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TTY_PRELOAD,
  card,
  fakeBin,
  issueBody,
  issueByCard,
  iterationField,
  makeWorkspace,
  plainField,
  project,
  projectsMap,
  runSync,
  selectField,
} from "./fixtures/sync-harness.mjs";
import { loadStatusColumnsCatalog } from "./lib.mjs";

const STATUS_SPECS = (await loadStatusColumnsCatalog({ cardsRoot: join(tmpdir(), "hyperion-no-cards"), repoConfig: { locale: "en" } })).specs;
const TYPES = ["Epic", "Feature", "Story", "Task", "Subtask", "Bug"];
const PRIORITIES = ["Highest", "High", "Medium", "Low"];
const KIT_VIEWS = [
  { id: "V_1", name: "Board", layout: "BOARD_LAYOUT" },
  { id: "V_2", name: "Tabela", layout: "TABLE_LAYOUT" },
  { id: "V_3", name: "Roadmap", layout: "ROADMAP_LAYOUT" },
];

/** Status field already matching the kit columns (no missing option, no color drift). */
function kitStatusField(id = "F_status") {
  return selectField(
    id,
    "Status",
    STATUS_SPECS.map((s, i) => ({ id: `${id}_o${i}`, name: s.name, color: s.color, description: s.description }))
  );
}

function optionId(field, name) {
  return field.options.find((o) => o.name === name).id;
}

function itemFor(state, proj, cardId) {
  return state.projects.find((p) => p.id === proj.id).items.find((i) => i.issueId === issueByCard(state, cardId).id);
}

function withWorkspace(opts, fn) {
  const ws = makeWorkspace(opts);
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

test("forward creates/updates issues, enriches bodies, links sub-issues and sets every Project field type", () => {
  const fields = [
    { ...kitStatusField(), options: kitStatusField().options.map((o, i) => (i === 0 ? { ...o, color: "RED" } : o)) },
    selectField("F_type", "Type", TYPES),
    selectField("F_prio", "Priority", PRIORITIES),
    iterationField("F_sprint", "Sprint", ["Sprint 1", "Sprint 2"]),
    plainField("F_sp", "Story Points", "NUMBER"),
    plainField("F_rep", "Reporter", "TEXT"),
    plainField("F_parent", "Parent (Epic/Feature)", "TEXT"),
    plainField("F_due", "Due Date", "DATE"),
  ];
  const board = project({
    scope: "organization",
    fields,
    items: [{ id: "PVTI_draft", issueId: null, values: {} }, { id: "PVTI_s2", issueId: "I_7", values: {} }],
    views: [{ id: "V_a", name: "Main", layout: "TABLE_LAYOUT" }, { id: "V_b", name: "Old", layout: "BOARD_LAYOUT" }, { id: "V_c", name: "Older", layout: "BOARD_LAYOUT" }],
  });
  const cards = {
    "epics/APP-E1.md": card({
      id: "APP-E1",
      type: "Epic",
      status: "In Progress",
      priority: "Highest",
      parent: "APP-GONE",
      categories: ["Backend"],
      extra: ['board_sync_at: "2026-01-01T00:00:00Z"'],
      body: "# Epic\n\n## Sub-issues\n\n- APP-F1\n- [Docs](https://example.com)\n- APP-NOPE\n",
    }),
    "features/APP-F1.md": card({
      id: "APP-F1",
      type: "Feature",
      status: "Done",
      priority: "Med",
      sprint: "Sprint 2",
      storyPoints: 5,
      reporter: "alice",
      dueDate: "2026-03-01",
      parent: "APP-E1",
      categories: ["Frontend", "Backend"],
      body: "# Feature\n\n## Summary\n\nText\n\n## Sub-issues\n\n- APP-S1\n",
    }),
    "stories/APP-S1.md": card({
      id: "APP-S1",
      type: "Spike",
      priority: "Someday",
      sprint: "Sprint 99",
      storyPoints: "lots",
      dueDate: "soon",
      parent: "APP-F1",
      body: "## Parent\n\n- APP-F1\n- APP-NOPE\nnot a bullet\n\n## Notes\n\n- APP-F1 stays\n",
    }),
    "stories/APP-S2.md": card({ id: "APP-S2", reporter: "bob", parent: "APP-F1", body: "# S2\n\n## Summary of changes\n\nshort\n" }),
    "tasks/APP-T1.md": card({ id: "APP-T1", type: "Task", parent: "APP-S2", body: "# T1\n\nplain" }),
    "stories/notes.md": "no frontmatter here\n",
    "_examples/EXAMPLE-1.md": card({ id: "EXAMPLE-1" }),
  };
  withWorkspace({ cards, config: projectsMap({ projectNumber: 1, labels: [{ name: "Backend", color: "#00ff00", description: "Server" }] }) }, (ws) => {
    const run = runSync(ws, [], {
      state: {
        pageSize: 1,
        projects: [board],
        labels: { Backend: { id: "LA_backend", color: "123456", description: "" } },
        issues: [{ id: "I_7", number: 7, title: "[Story] Old S2", body: issueBody({ cardId: "APP-S2", sourceFile: ".github/cards/stories/APP-S2.md" }), state: "OPEN", author: { login: "alice" } }],
        fail: { getProject: ["repository"] },
      },
    });
    assert.equal(run.status, 0, run.output);
    const { state, logs } = run;
    const issue = (id) => issueByCard(state, id);

    assert.equal(state.issues.length, 5);
    assert.equal(issue("APP-S2").number, 7);
    assert.equal(issue("APP-S2").title, "[Story] Card APP-S2");
    assert.equal(issue("APP-E1").title, "[Epic] Card APP-E1");
    assert.equal(state.log.filter((m) => m.op === "createIssue").length, 4);

    const url = (id) => `https://github.com/acme/app/issues/${issue(id).number}`;
    const e1 = issue("APP-E1").body;
    assert.ok(e1.includes(`- [APP-F1 (#${issue("APP-F1").number})](${url("APP-F1")})`), e1);
    assert.ok(e1.includes("- [Docs](https://example.com)\n- APP-NOPE"));
    assert.ok(e1.includes("PARENT_CARD_ID: APP-GONE") && e1.includes("BOARD_SYNC_AT: 2026-01-01T00:00:00Z"));
    assert.ok(!e1.includes("## 👆"), "unknown parent gets no parent section");
    const f1 = issue("APP-F1").body;
    assert.ok(f1.indexOf("## 👆 Parent") < f1.indexOf("## 🔗 Sub-issues") && f1.indexOf("## 👆 Parent") > f1.indexOf("## 📋 Summary"));
    const s1 = issue("APP-S1").body;
    assert.equal(s1.match(/## 👆 Parent/g).length, 1, s1);
    assert.ok(s1.includes(`## 👆 Parent\n\n- [APP-F1 (#${issue("APP-F1").number})](${url("APP-F1")})\n- APP-NOPE\nnot a bullet\n\n## Notes\n\n- APP-F1 stays`), s1);
    const s2 = issue("APP-S2").body;
    assert.ok(s2.includes("# S2\n\n## 👆 Parent\n\n- [APP-F1") && s2.indexOf("## 👆 Parent") < s2.indexOf("## Summary of changes"), s2);
    assert.match(issue("APP-T1").body, /plain\n\n## 👆 Parent\n\n- \[APP-S2 \(#7\)\]/);

    const pairs = state.subIssues.map(([p, c]) => `${p}>${c}`).sort();
    assert.deepEqual(pairs, [
      `${issue("APP-E1").id}>${issue("APP-F1").id}`,
      `${issue("APP-F1").id}>${issue("APP-S1").id}`,
      `${issue("APP-F1").id}>${issue("APP-S2").id}`,
      `${issue("APP-S2").id}>${issue("APP-T1").id}`,
    ].sort());

    assert.deepEqual(state.labels.Backend, { id: "LA_backend", color: "00ff00", description: "Server" });
    assert.ok(state.labels.Frontend?.id, "missing category label is created");
    assert.deepEqual(issue("APP-F1").labels.sort(), ["Backend", "Frontend"]);

    const p = state.projects[0];
    const f = (name) => p.fields.find((x) => x.name === name);
    assert.deepEqual(itemFor(state, board, "APP-E1").values, {
      F_status: { singleSelectOptionId: optionId(f("Status"), "In Progress") },
      F_type: { singleSelectOptionId: optionId(f("Type"), "Epic") },
      F_prio: { singleSelectOptionId: optionId(f("Priority"), "Highest") },
      F_parent: { text: "APP-GONE" },
    });
    assert.deepEqual(itemFor(state, board, "APP-F1").values, {
      F_status: { singleSelectOptionId: optionId(f("Status"), "Done") },
      F_type: { singleSelectOptionId: optionId(f("Type"), "Feature") },
      F_prio: { singleSelectOptionId: optionId(f("Priority"), "Medium") },
      F_sprint: { iterationId: "F_sprint_it1" },
      F_sp: { number: 5 },
      F_rep: { text: "alice" },
      F_parent: { text: `${url("APP-E1")} (APP-E1)` },
      F_due: { date: "2026-03-01" },
    });
    assert.deepEqual(itemFor(state, board, "APP-S1").values, {
      F_status: { singleSelectOptionId: optionId(f("Status"), "Backlog") },
      F_parent: { text: `${url("APP-F1")} (APP-F1)` },
    });
    assert.equal(itemFor(state, board, "APP-S2").id, "PVTI_s2", "existing project item is reused");
    assert.deepEqual(itemFor(state, board, "APP-S2").values, { F_type: { singleSelectOptionId: optionId(f("Type"), "Story") }, F_rep: { text: "bob" }, F_parent: { text: `${url("APP-F1")} (APP-F1)` } });

    assert.deepEqual(p.views.map((v) => `${v.name}:${v.layout}`), ["Board:BOARD_LAYOUT", "Tabela:TABLE_LAYOUT", "Roadmap:ROADMAP_LAYOUT"]);
    assert.equal(p.views[0].id, "V_a");
    assert.equal(f("Status").options[0].color, STATUS_SPECS[0].color);
    assert.equal(f("Type").options.find((o) => o.name === "Bug").color, "RED");
    assert.equal(f("Priority").options.find((o) => o.name === "High").color, "ORANGE");

    for (const line of [
      "SKIP (no frontmatter/card_id): .github/cards/stories/notes.md",
      "Provisioning 1 labels...",
      "  ~ Status columns updated (colors + descriptions)",
      "  ~ Type/Tipo colors updated (6 options)",
      "  + Project views configured",
      "  = Sprint iteration field exists: Sprint (2 iteration(s))",
      "Project found: owner=acme number=1",
    ]) {
      assert.ok(logs.includes(line), `missing log: ${line}`);
    }
    assert.deepEqual(
      run.actions.filter((a) => a.action === "ADDED_TO_PROJECT").map((a) => a.cardId).sort(),
      ["APP-E1", "APP-F1", "APP-S1", "APP-T1"]
    );
    assert.match(ws.read(".github/plans/cards/last-sync.md"), /\| APP-E1 \| CREATED \| https:\/\/github\.com\/acme\/app\/issues\/\d+ \|/);
  });
});

test("forward auto-creates a Project with the kit fields, views and Sprint iterations, and saves its number", () => {
  const config = projectsMap({
    autoCreateProject: true,
    autoDiscoverProject: false,
    createMissingLabels: false,
    sprintField: { durationDays: 7, startDate: "2026-01-05", seedIterations: [{ title: "Sprint 1", startDate: "2026-01-05" }, { title: "Sprint 2", startDate: "2026-01-12", duration: 14 }] },
  });
  const cards = { "stories/APP-1.md": card({ id: "APP-1", status: "Backlog", type: "Story", categories: ["Ghost", "Known"] }) };
  withWorkspace({ cards, config }, (ws) => {
    const run = runSync(ws, [], {
      state: {
        owners: { user: null, organization: "O_1" },
        fail: { ownerId: ["user"] },
        newProjectScope: "organization",
        newProjectFields: [selectField("F_status", "Status", ["Todo", "In Progress", "Done"]), selectField("F_type", "Type", TYPES)],
        labels: { Known: { id: "LA_known", color: "abcdef", description: "" } },
      },
    });
    assert.equal(run.status, 0, run.output);
    const created = run.state.projects[0];
    assert.equal(created.title, "app Hyperion Project");
    assert.equal(created.number, 1);
    assert.deepEqual(created.repos, ["acme/app"]);
    assert.deepEqual(
      created.fields.map((f) => `${f.name}:${f.__typename}${f.dataType ? `/${f.dataType}` : ""}`),
      [
        "Status:ProjectV2SingleSelectField",
        "Type:ProjectV2SingleSelectField",
        "Priority:ProjectV2SingleSelectField",
        "Sprint:ProjectV2IterationField",
        "Story Points:ProjectV2Field/NUMBER",
        "Reporter:ProjectV2Field/TEXT",
        "Parent (Epic/Feature):ProjectV2Field/TEXT",
        "Due Date:ProjectV2Field/DATE",
      ]
    );
    const sprintCreate = run.state.log.find((m) => m.op === "createField" && m.name === "Sprint");
    assert.deepEqual(sprintCreate.config, {
      duration: 7,
      startDate: "2026-01-05",
      iterations: [{ title: "Sprint 1", startDate: "2026-01-05", duration: 7 }, { title: "Sprint 2", startDate: "2026-01-12", duration: 14 }],
    });
    const priorityCreate = run.state.log.find((m) => m.op === "createField" && m.name === "Priority");
    assert.deepEqual(priorityCreate.options.map((o) => `${o.name}:${o.color}`), ["Highest:RED", "High:ORANGE", "Medium:YELLOW", "Low:GRAY"]);
    assert.deepEqual(created.fields[0].options.map((o) => o.name), STATUS_SPECS.map((s) => s.name));
    assert.deepEqual(created.views.map((v) => v.name), ["Board", "Tabela", "Roadmap"]);

    const saved = ws.readJson(".github/cards/config/projects-map.json").default;
    assert.equal(saved.projectNumber, 1);
    assert.equal(saved.projectOwner, "acme");

    const issue = issueByCard(run.state, "APP-1");
    assert.deepEqual(issue.labels, ["Known"]);
    assert.equal(created.items[0].issueId, issue.id);
    assert.deepEqual(created.items[0].values.F_status, { singleSelectOptionId: created.fields[0].options.find((o) => o.name === "Backlog").id });
    for (const line of [
      "Project not found. Auto-creating...",
      'Project created: "app Hyperion Project" (number 1)',
      "  + Default repository: acme/app",
      "  = Field exists: Type (skip)",
      "  + Field created: Due Date",
      `  ~ Status field updated — added ${STATUS_SPECS.filter((s) => !["Todo", "In Progress", "Done"].includes(s.name)).length} missing column(s)`,
      "  + Project views created",
      "  = Sprint iteration field exists: Sprint (2 iteration(s))",
      "  projects-map.json updated: default.projectNumber=1, projectOwner=acme",
      "Labels skipped (not found): Ghost",
    ]) {
      assert.ok(run.logs.includes(line), `missing log: ${line}\n${run.stdout}`);
    }
  });
});

test("forward discovers and persists the repo's Project, links it, and keeps a matching board untouched", () => {
  const board = project({
    number: 3,
    title: "app Hyperion Project",
    repos: [],
    fields: [kitStatusField(), selectField("F_tipo", "Tipo", TYPES), plainField("F_sprint", "Sprint", "TEXT")],
    views: KIT_VIEWS,
  });
  const cards = { "features/APP-F.md": card({ id: "APP-F", type: "Feature", sprint: "S1" }) };
  withWorkspace({ cards, files: { ".github/project.yml": "name: app\nlocale: en\n" } }, (ws) => {
    const run = runSync(ws, [], { state: { projects: [board] } });
    assert.equal(run.status, 0, run.output);
    assert.equal(ws.readJson(".github/cards/config/projects-map.json").default.projectNumber, 3);
    const p = run.state.projects[0];
    assert.deepEqual(p.repos, ["acme/app"]);
    assert.equal(run.state.log.filter((m) => m.op === "updateField").length, 1, "only the Tipo colors are rewritten");
    assert.deepEqual(p.items[0].values, {
      F_status: { singleSelectOptionId: "F_status_o0" },
      F_tipo: { singleSelectOptionId: "F_tipo_o1" },
      F_sprint: { text: "S1" },
    });
    for (const line of [
      'Auto-discovered GitHub Project #3: "app Hyperion Project"',
      `  = Status columns OK (${STATUS_SPECS.length} options, metadata synced)`,
      "  = Project views already configured (Board → Tabela → Roadmap)",
      '  WARN: Sprint field "Sprint" exists but is not Iteration type',
      "  + Project linked to repository: acme/app",
    ]) {
      assert.ok(run.logs.includes(line), `missing log: ${line}`);
    }
  });
});

test("forward --dry-run with a token reads the board, prints the plan and sends no mutations", () => {
  const cards = {
    "stories/APP-1.md": card({ id: "APP-1", parent: "APP-2" }),
    "stories/APP-2.md": card({ id: "APP-2", categories: ["Backend"] }),
  };
  withWorkspace({ cards, config: projectsMap({ labels: ["Backend"] }) }, (ws) => {
    const before = ws.read(".github/cards/config/projects-map.json");
    const run = runSync(ws, ["--dry-run"], {
      state: {
        projects: [project({ number: 5, title: "app Hyperion Project", fields: [kitStatusField()] })],
        issues: [{ id: "I_1", number: 1, title: "x", body: issueBody({ cardId: "APP-1", sourceFile: ".github/cards/stories/APP-1.md" }), state: "OPEN" }],
      },
    });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.state.log, []);
    assert.equal(ws.read(".github/cards/config/projects-map.json"), before);
    assert.ok(!ws.exists(".github/plans/cards/last-sync.md"));
    for (const line of [
      "Dry-run: yes",
      'Auto-discovered GitHub Project #5: "app Hyperion Project" (dry-run — not saved to projects-map.json)',
      "=== DRY-RUN REPORT ===",
      "Hierarchy:",
      "  APP-2 -> APP-1",
    ]) {
      assert.ok(run.logs.includes(line), `missing log: ${line}`);
    }
    assert.ok(run.logs.some((l) => /^\| APP-2 +\| Story +\| CREATE +\| — +\| Backend +\|$/.test(l)), run.stdout);
    assert.ok(run.logs.some((l) => /^\| APP-1 +\| Story +\| UPDATE +\| APP-2 +\| +\|$/.test(l)), run.stdout);
  });
});

test("forward keeps a single Parent section and places a new one above the decorated Summary", () => {
  const cards = {
    "epics/APP-E.md": card({ id: "APP-E", type: "Epic" }),
    "stories/APP-A.md": card({ id: "APP-A", parent: "APP-E", body: "# A\n\nIntro\n\n## Parent\n\n- APP-E\n" }),
    "stories/APP-B.md": card({ id: "APP-B", parent: "APP-E", body: "# B\n\n## Summary\n\nText\n\n## Notes\n\nmore\n" }),
  };
  withWorkspace({ cards, config: projectsMap({ autoCreateProject: false, autoDiscoverProject: false }) }, (ws) => {
    const run = runSync(ws);
    assert.equal(run.status, 0, run.output);
    const epic = issueByCard(run.state, "APP-E");
    const link = `[APP-E (#${epic.number})](https://github.com/acme/app/issues/${epic.number})`;

    const a = issueByCard(run.state, "APP-A").body;
    assert.equal(a.match(/^## .*Parent/gm).length, 1, a);
    assert.ok(a.includes(`## 👆 Parent\n\n- ${link}`), a);

    const b = issueByCard(run.state, "APP-B").body;
    assert.ok(b.includes(`# B\n\n## 👆 Parent\n\n- ${link}\n\n## 📋 Summary`), b);
  });
});

test("forward recognizes localized Parent headings exactly and skips headings that only mention it", () => {
  const cards = {
    "epics/APP-E.md": card({ id: "APP-E", type: "Epic" }),
    "stories/APP-A.md": card({ id: "APP-A", parent: "APP-E", body: "# A\n\n## 👆 Card pai\n\n- APP-E\n" }),
    "stories/APP-B.md": card({ id: "APP-B", parent: "APP-E", body: "# B\n\n## ⬆️ Tarjeta padre\n\n- APP-E\n" }),
    "stories/APP-C.md": card({ id: "APP-C", parent: "APP-E", body: "# C\n\n## Parent company notes\n\n- APP-E\n" }),
    "stories/APP-D.md": card({ id: "APP-D", parent: "APP-E", body: "# D\n\n## 🧑‍💻 Resumo\n\nTexto\n" }),
  };
  const files = { ".github/project.yml": "name: app\nlocale: pt-BR\n" };
  withWorkspace({ cards, files, config: projectsMap({ autoCreateProject: false, autoDiscoverProject: false }) }, (ws) => {
    const run = runSync(ws);
    assert.equal(run.status, 0, run.output);
    const epic = issueByCard(run.state, "APP-E");
    const link = `[APP-E (#${epic.number})](https://github.com/acme/app/issues/${epic.number})`;
    const body = (id) => issueByCard(run.state, id).body;

    assert.ok(body("APP-A").includes(`## 👆 Card pai\n\n- ${link}`), body("APP-A"));
    assert.equal(body("APP-A").match(/^## .*Card pai/gmu).length, 1, body("APP-A"));

    assert.ok(body("APP-B").includes(`## ⬆️ Tarjeta padre\n\n- ${link}`), body("APP-B"));
    assert.ok(!body("APP-B").includes("## 👆 Card pai"), body("APP-B"));

    assert.ok(body("APP-C").includes("## Parent company notes\n\n- APP-E\n"), body("APP-C"));
    assert.ok(body("APP-C").includes(`## 👆 Card pai\n\n- ${link}`), body("APP-C"));

    assert.ok(body("APP-D").includes(`# D\n\n## 👆 Card pai\n\n- ${link}\n\n## 🧑‍💻 Resumo`), body("APP-D"));
  });
});

test("forward reads management hints from project.yml when the block is last or a value contains Z", () => {
  const cards = { "stories/APP-1.md": card({ id: "APP-1" }) };
  for (const projectYml of [
    "name: app\nlocale: en\nmanagement:\n  backend: azure-devops\n",
    "management:\n  org: https://dev.azure.com/Zenith\n  backend: azure-devops\nlocale: en\n",
  ]) {
    withWorkspace({ cards, files: { ".github/project.yml": projectYml } }, (ws) => {
      const run = runSync(ws);
      assert.equal(run.status, 1, run.output);
      assert.ok(run.logs.includes("Backend: azure-devops"), run.stdout);
      assert.match(run.output, /Azure DevOps backend requires AZDO_ORG_URL, AZDO_PROJECT, and AZDO_PAT/);
    });
  }
});

test("forward with several candidate Projects neither guesses nor auto-creates", () => {
  withWorkspace({ cards: { "stories/APP-1.md": card({ id: "APP-1" }) } }, (ws) => {
    const run = runSync(ws, [], { state: { projects: [project({ number: 1, title: "Alpha", repos: [] }), project({ number: 2, title: "Beta", repos: [] })] } });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.state.projects.length, 2);
    assert.equal(run.state.log.filter((m) => m.op === "createProject").length, 0);
    const i = run.logs.indexOf("Auto-create skipped: multiple GitHub Projects found — set projectNumber in projects-map.json");
    assert.ok(run.logs.includes("Multiple GitHub Projects found — set projectNumber in projects-map.json"));
    assert.deepEqual(run.logs.slice(i + 1, i + 4), ["  candidate: #1 Alpha", "  candidate: #2 Beta", "Run: npm run cards:doctor"]);
  });
});

test("forward records per-card failures, keeps going, and exits 1 when an issue cannot be written", () => {
  const cards = {
    "stories/APP-1.md": card({ id: "APP-1" }),
    "stories/APP-2.md": card({ id: "APP-2", categories: ["Backend"], status: "Backlog" }),
    "stories/APP-3.md": card({ id: "APP-3", parent: "APP-2", status: "Backlog" }),
  };
  const board = project({ repos: [], fields: [plainField("F_status", "Status", "TEXT")], views: KIT_VIEWS });
  withWorkspace({ cards, config: projectsMap({ projectNumber: 1 }), files: { ".github/plans": "not a directory" } }, (ws) => {
    const run = runSync(ws, [], {
      state: {
        projects: [board],
        fail: {
          createIssue: ["Card APP-1"],
          addLabels: true,
          updateIssue: ["`APP-2`"],
          addSubIssue: true,
          issues: { skip: 1 },
          addItem: { times: 1 },
          setFieldValue: { times: 1 },
          linkProject: true,
        },
      },
    });
    assert.equal(run.status, 1, run.output);
    const byAction = (name) => run.actions.filter((a) => a.action === name);
    assert.deepEqual(byAction("ISSUE_SYNC_FAILED").map((a) => [a.cardId, a.reason]), [["APP-1", 'GraphQL failed: [\n  {\n    "message": "createIssue failed"\n  }\n]']]);
    assert.deepEqual(byAction("LABELS_FAILED").map((a) => a.cardId), ["APP-2"]);
    assert.deepEqual(byAction("BODY_ENRICH_FAILED").map((a) => a.cardId), ["APP-2"]);
    assert.deepEqual(byAction("BODY_ENRICHED").map((a) => a.cardId), ["APP-3"]);
    assert.deepEqual(byAction("LINK_FAILED").map((a) => [a.parent, a.child]), [["APP-2", "APP-3"]]);
    assert.equal(byAction("PROJECT_LINK_FAILED").length, 1);
    assert.deepEqual(byAction("PROJECT_ADD_FAILED").map((a) => a.cardId), ["APP-2"]);
    assert.deepEqual(byAction("FIELD_UPDATE_FAILED").map((a) => a.cardId), ["APP-3"]);
    assert.ok(run.logs.some((l) => l.startsWith("Could not load full issue map for link enrichment: GraphQL failed")));
    assert.ok(run.logs.some((l) => l.startsWith("  WARN: Could not link project to repository: GraphQL failed")));
    assert.ok(run.logs.some((l) => l.startsWith("Could not write sync summary:")));
    assert.ok(run.logs.includes("1 issue(s) failed to create/update: APP-1"));
    assert.ok(!issueByCard(run.state, "APP-1"));
  });
});

test("forward logs a WARN (and continues) when Project fields, colors, views or Sprint can't be configured", () => {
  const board = project({
    fields: [selectField("F_status", "Status", ["Archived"]), selectField("F_type", "Type", TYPES), { __typename: "ProjectV2Mystery", id: "F_due", name: "Due Date" }],
    views: [{ id: "V_x", name: "Mine", layout: "TABLE_LAYOUT" }],
  });
  const cards = { "stories/APP-1.md": card({ id: "APP-1", type: "Bug", dueDate: "2026-02-02" }) };
  withWorkspace({ cards, config: projectsMap({ projectNumber: 1 }) }, (ws) => {
    const run = runSync(ws, [], { state: { projects: [board], fail: { updateField: true, updateView: true, createField: ["Sprint"] } } });
    assert.equal(run.status, 0, run.output);
    const p = run.state.projects[0];
    assert.deepEqual(p.views, [{ id: "V_x", name: "Mine", layout: "TABLE_LAYOUT" }]);
    assert.deepEqual(p.items[0].values, { F_type: { singleSelectOptionId: "F_type_o5" } }, "status has no matching option, unknown field type is ignored");
    for (const prefix of [
      "  WARN: Could not update Status options automatically: GraphQL failed",
      "  Customize Status columns manually in Project Settings.",
      "  WARN: Could not update Type/Tipo colors: GraphQL failed",
      "  WARN: Could not configure project views automatically: GraphQL failed",
      "  Customize views manually: Board (first) → Tabela → Roadmap",
      "  WARN: Could not create Sprint iteration field: GraphQL failed",
      "  Create an Iteration field manually in Project Settings if needed.",
    ]) {
      assert.ok(run.logs.some((l) => l.startsWith(prefix)), `missing log: ${prefix}`);
    }
  });
});

test("forward --only syncs the targets plus their parents and reports a missing Project", () => {
  const cards = {
    "epics/APP-E.md": card({ id: "APP-E", type: "Epic" }),
    "stories/APP-S.md": card({ id: "APP-S", parent: "APP-E" }),
    "stories/APP-X.md": card({ id: "APP-X" }),
  };
  withWorkspace({ cards, config: projectsMap({ projectNumber: 42 }) }, (ws) => {
    const run = runSync(ws, ["--only", "APP-S"], { state: { fail: { getProject: true } } });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.state.issues.map((i) => i.title).sort(), ["[Epic] Card APP-E", "[Story] Card APP-S"]);
    assert.deepEqual(run.state.subIssues.length, 1);
    for (const line of [
      "Incremental sync: 1 target(s) → 2 card(s) including parents",
      "Valid cards: 2 (of 3 syncable)",
      "Project not found: owner=acme number=42",
      "Project #42 not found — check projectOwner/projectNumber in config.",
    ]) {
      assert.ok(run.logs.includes(line), `missing log: ${line}`);
    }
    assert.match(ws.read(".github/plans/cards/last-sync.md"), /\*\*Incremental:\*\* APP-S/);
  });
});

test("forward survives an unwritable projects-map.json: discovery and project-number save are skipped with a log", () => {
  withWorkspace({ cards: { "stories/APP-1.md": card({ id: "APP-1" }) }, config: null }, (ws) => {
    mkdirSync(ws.path(".github/cards/config/projects-map.json"), { recursive: true });
    const run = runSync(ws, [], { state: { projects: [project({ number: 1, title: "app Hyperion Project", repos: [] })] } });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.state.projects.length, 2, "a new Project is created because the discovered one could not be saved");
    const status = run.state.projects[1].fields.find((f) => f.name === "Status");
    assert.deepEqual(status.options.map((o) => o.name), STATUS_SPECS.map((s) => s.name));
    for (const prefix of [
      "Project auto-discovery skipped:",
      "  + Status field created (7 columns, colors + descriptions)",
      "  Could not auto-save projectNumber to config:",
      '  Manually set "projectNumber": 2 in projects-map.json',
    ]) {
      assert.ok(run.logs.some((l) => l.startsWith(prefix)), `missing log: ${prefix}\n${run.stdout}`);
    }
  });
});

test("forward reports a failed Project auto-create when the owner can't be resolved", () => {
  withWorkspace({ cards: { "stories/APP-1.md": card({ id: "APP-1" }) } }, (ws) => {
    const run = runSync(ws, [], { state: { owners: { user: null, organization: null } } });
    assert.equal(run.status, 0, run.output);
    assert.ok(run.logs.includes('Auto-create project failed: Cannot resolve owner node ID for "acme". Check permissions.'));
    assert.equal(run.state.issues.length, 1);
  });
});

test("forward stops early, with a reason, when there is nothing to sync", () => {
  const config = projectsMap({ projectNumber: 1 });
  withWorkspace({ cards: { "_examples/EXAMPLE-1.md": card({ id: "EXAMPLE-1" }) }, config }, (ws) => {
    const run = runSync(ws);
    assert.equal(run.status, 0, run.output);
    assert.ok(run.logs.includes("No card files found in .github/cards/"));
    assert.ok(run.logs.includes("  (1 kit sample card(s) under _examples/ excluded from sync — expected. Add real cards under epics/features/stories/tasks/.)"));
  });
  withWorkspace({ cards: { "stories/a.md": "# no frontmatter\n" }, config }, (ws) => {
    const run = runSync(ws);
    assert.ok(run.logs.includes("No valid cards found (all files missing YAML frontmatter with card_id)."));
  });
  withWorkspace({ cards: { "stories/EXAMPLE-9.md": card({ id: "EXAMPLE-9" }) }, config }, (ws) => {
    const run = runSync(ws, ["--only", "EXAMPLE-9"]);
    assert.equal(run.status, 0, run.output);
    assert.equal(run.calls.length, 0);
    for (const line of [
      "Skipping 1 kit sample card(s) (EXAMPLE/TEMPLATE/SAMPLE — reference only). Real project cards sync normally.",
      "Ignored kit sample target(s): EXAMPLE-9 (use --include-samples only for kit maintenance).",
      "No cards to sync. Add project cards under .github/cards/{epics,features,stories,tasks}/ — kit samples in _examples/ and *.template.md are never synced.",
    ]) {
      assert.ok(run.logs.includes(line), `missing log: ${line}`);
    }
  });
});

test("forward dispatches to the configured non-GitHub backend; setup errors print only the actionable message", () => {
  const cards = { "stories/APP-1.md": card({ id: "APP-1" }) };
  withWorkspace({ cards }, (ws) => {
    const run = runSync(ws, ["--forward", "--verbose"], { env: { CARDS_SYNC_BACKEND: "jira" } });
    assert.equal(run.status, 1);
    assert.ok(run.logs.includes("Backend: jira"));
    assert.match(run.stderr, /^\[cards-sync\] Jira backend requires JIRA_URL, JIRA_PROJECT_KEY, JIRA_EMAIL, and JIRA_API_TOKEN \(env or config\)\.\r?\n/);
    assert.match(run.stderr, /at runForwardSyncJira/, "--verbose keeps the stack");
    assert.doesNotMatch(run.stderr, /FATAL/);
  });
  const projectYml = [
    "management:",
    "  backend: azure-devops",
    "  org: null",
    "  project: Web # inline comment",
    "  status_map:",
    '    Done: "Closed"',
    "    In Progress: Active",
    "locale: en",
    "",
  ].join("\n");
  withWorkspace({ cards, files: { ".github/project.yml": projectYml } }, (ws) => {
    const run = runSync(ws);
    assert.equal(run.status, 1);
    assert.ok(run.logs.includes("Backend: azure-devops"));
    assert.equal(run.stderr.trim(), "[cards-sync] Azure DevOps backend requires AZDO_ORG_URL, AZDO_PROJECT, and AZDO_PAT (env or config).");
  });
  withWorkspace({ cards, config: projectsMap({ backend: "linear" }) }, (ws) => {
    const run = runSync(ws);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Linear backend requires LINEAR_TEAM_ID and LINEAR_API_TOKEN/);
  });
  withWorkspace({ cards, config: projectsMap({ management: { backend: "gitlab" } }) }, (ws) => {
    const run = runSync(ws);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /GitLab backend requires GITLAB_PROJECT_ID and GITLAB_TOKEN/);
  });
});

test("forward falls back to the gh CLI token and an SSH git remote, warning that it uses the local identity", () => {
  const cards = { "stories/APP-1.md": card({ id: "APP-1" }) };
  withWorkspace({ cards, config: projectsMap({ projectNumber: 1 }) }, (ws) => {
    const bin = fakeBin(ws, { gh: "gh-local-token", git: "git@github.com:octo/web.git" });
    const run = runSync(ws, [], {
      env: { PROJECT_SYNC_TOKEN: undefined, GITHUB_REPOSITORY: undefined, Path: undefined, PATH: bin },
      state: { repoSlug: "octo/web", projects: [project({ repos: ["octo/web"], fields: [kitStatusField()], views: KIT_VIEWS })] },
    });
    assert.equal(run.status, 0, run.output);
    assert.ok(run.logs.includes("Repository: octo/web"));
    assert.ok(run.logs.includes("Token source: gh-cli"));
    assert.ok(run.logs.some((l) => l.startsWith("Warning: no PROJECT_SYNC_TOKEN/GITHUB_TOKEN set — falling back to your local `gh auth token` session.")));
    assert.ok(run.calls.every((c) => c.headers.Authorization === "Bearer gh-local-token"));
    assert.equal(run.state.issues[0].title, "[Story] Card APP-1");
  });
});

test("forward without any token: dry-run prints the plan offline, a live run fails fast", () => {
  const cards = { "stories/APP-1.md": card({ id: "APP-1", parent: "APP-0" }), "epics/APP-0.md": card({ id: "APP-0", type: "Epic" }) };
  withWorkspace({ cards, config: projectsMap({ labels: ["Backend"] }) }, (ws) => {
    const bin = fakeBin(ws, { git: "https://gitlab.com/acme/app.git" });
    const noToken = { PROJECT_SYNC_TOKEN: undefined, GITHUB_REPOSITORY: undefined, Path: undefined, PATH: bin };

    const dry = runSync(ws, [], { env: { ...noToken, DRY_RUN: "true" } });
    assert.equal(dry.status, 0, dry.output);
    assert.equal(dry.calls.length, 0);
    assert.ok(dry.logs.includes("Repository: unknown/unknown"));
    assert.ok(dry.logs.includes("Token source: none"));
    assert.ok(dry.logs.includes("Total parent-child links: 1"));

    const live = runSync(ws, [], { env: noToken });
    assert.equal(live.status, 1);
    assert.match(live.stderr, /\[cards-sync\] FATAL ERROR\r?\nError: GITHUB_REPOSITORY not set\. Expected: owner\/repo/);

    const noTokenOnly = runSync(ws, [], { env: { ...noToken, GITHUB_REPOSITORY: "acme/app" } });
    assert.equal(noTokenOnly.status, 1);
    assert.match(noTokenOnly.stderr, /Token missing\. Set GITHUB_TOKEN or PROJECT_SYNC_TOKEN/);
  });
});

test("a live run at an interactive terminal asks for confirmation first", () => {
  withWorkspace({ cards: {}, config: projectsMap({ projectNumber: 1 }) }, (ws) => {
    const nodeOptions = `${process.env.NODE_OPTIONS || ""} --import ${TTY_PRELOAD}`.trim();
    const declined = runSync(ws, [], { env: { NODE_OPTIONS: nodeOptions }, input: "no\n" });
    assert.equal(declined.status, 1, declined.output);
    assert.match(declined.stdout, /This will write to your LIVE board \(no --dry-run\)\. Type "yes" to continue: /);
    assert.ok(declined.stdout.includes("[cards-sync] Aborted — nothing written. Pass --yes (or CARDS_SYNC_YES=true) to skip this prompt."));
    assert.equal(declined.calls.length, 0);

    const accepted = runSync(ws, [], { env: { NODE_OPTIONS: nodeOptions }, input: "YES\n" });
    assert.equal(accepted.status, 0, accepted.output);
    assert.ok(accepted.stdout.includes("[cards-sync] No card files found in .github/cards/"));
  });
});
