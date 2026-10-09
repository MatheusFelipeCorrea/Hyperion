import test from "node:test";
import assert from "node:assert/strict";
import { captureLogs, setupWorkspace } from "./backends/sync-fixture.mjs";
import {
  card,
  fakeBin,
  issueBody,
  iterationField,
  makeWorkspace,
  plainField,
  project,
  projectsMap,
  runSync,
  selectField,
} from "./fixtures/sync-harness.mjs";

// In-process half: sync.mjs binds its workspace to process.cwd() at load time.
const inProcess = setupWorkspace();
const { applyReverseCardFileUpdate, countReverseWrite } = await import("./sync.mjs");
test.after(() => inProcess.cleanup());

const E1 = ".github/cards/epics/APP-E1.md";
const S1 = ".github/cards/stories/APP-S1.md";
const S9 = ".github/cards/stories/APP-S9.md";
const BAD = ".github/cards/stories/APP-BAD.md";

function boardFields() {
  return [
    selectField("F_status", "Status", ["Backlog", "In Progress", "Done"]),
    selectField("F_type", "Type", ["Epic", "Story"]),
    selectField("F_prio", "Priority", ["High", "Low"]),
    iterationField("F_sprint", "Sprint", ["Sprint 1", "Sprint 2"]),
    plainField("F_sp", "Story Points", "NUMBER"),
    plainField("F_rep", "Reporter", "TEXT"),
    plainField("F_parent", "Parent (Epic/Feature)", "TEXT"),
    plainField("F_due", "Due Date", "DATE"),
  ];
}

/** A board where issue #1 carries every field type, #3 only a status, #2 noise that maps to nothing. */
function reverseState(overrides = {}) {
  const issue = (number, body, extra = {}) => ({ id: `I_${number}`, number, title: `[Story] Remote ${number}`, body, state: "OPEN", updatedAt: "2026-02-01T00:00:00Z", author: { login: "dev" }, labels: [], ...extra });
  return {
    pageSize: 2,
    projects: [
      project({
        fields: boardFields(),
        items: [
          {
            id: "PVTI_e1",
            issueId: "I_1",
            values: {
              F_status: { singleSelectOptionId: "F_status_o2" },
              F_type: { singleSelectOptionId: "F_type_o0" },
              F_prio: { singleSelectOptionId: "F_prio_o0" },
              F_sprint: { iterationId: "F_sprint_it1" },
              F_sp: { number: 8 },
              F_rep: { text: "carol" },
              F_parent: { text: "https://github.com/acme/app/issues/9 (APP-ROOT)" },
              F_due: { date: "2026-05-01" },
            },
          },
          { id: "PVTI_s1", issueId: "I_2", values: { F_rep: { text: "" }, F_gone: { text: "orphan field" } } },
          { id: "PVTI_s9", issueId: "I_3", values: { F_status: { singleSelectOptionId: "F_status_o0" } } },
          { id: "PVTI_draft", issueId: null, values: {} },
        ],
      }),
    ],
    issues: [
      issue(1, issueBody({ cardId: "APP-E1", sourceFile: E1 }), { title: "[Epic] Remote epic", updatedAt: "2026-02-01T10:00:00Z", labels: ["Backend"] }),
      issue(2, issueBody({ cardId: "APP-S1", sourceFile: S1 })),
      issue(3, issueBody({ cardId: "APP-S9", sourceFile: S9, body: "Created on the board", meta: { TYPE: "Story", PRIORITY: "Low", STORY_POINTS: "2" } }), { title: "[Story] New from board" }),
      issue(4, issueBody({ cardId: "APP-X" })),
      issue(5, issueBody({ cardId: "APP-BAD", sourceFile: BAD })),
      issue(6, issueBody({ cardId: "EXAMPLE-1", sourceFile: ".github/cards/_examples/EXAMPLE-1.md" })),
      issue(7, "A bug report without metadata"),
      issue(0, issueBody({ cardId: "APP-ZERO", sourceFile: ".github/cards/stories/APP-ZERO.md" })),
      { number: 99, title: "node without id" },
    ],
    ...overrides,
  };
}

function reverseWorkspace(config = projectsMap({ projectNumber: 1 })) {
  return makeWorkspace({
    config,
    cards: {
      "epics/APP-E1.md": card({ id: "APP-E1", type: "Epic", status: "Backlog", body: "# Epic\n\nKeep this body." }),
      "stories/APP-S1.md": card({ id: "APP-S1", extra: ['board_sync_at: "2026-02-01T00:00:00.000Z"'] }),
      "stories/APP-BAD.md": "no frontmatter at all\n",
    },
  });
}

function withWorkspace(ws, fn) {
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

test("reverse pulls Project fields and labels into card frontmatter, creates missing cards and skips what it can't map", () => {
  withWorkspace(reverseWorkspace(), (ws) => {
    const before = { s1: ws.read(S1), bad: ws.read(BAD) };
    const run = runSync(ws, ["--reverse"], { state: reverseState() });
    assert.equal(run.status, 0, run.output);

    const e1 = ws.read(E1);
    for (const line of [
      'card_id: "APP-E1"',
      'status: "Done"',
      'type: "Epic"',
      'priority: "High"',
      'sprint: "Sprint 2"',
      "story_points: 8",
      'reporter: "carol"',
      'parent: "APP-ROOT"',
      'due_date: "2026-05-01"',
      'board_sync_at: "2026-02-01T10:00:00.000Z"',
      'categories:\n  - "Backend"',
    ]) {
      assert.ok(e1.includes(`\n${line}\n`), `missing ${line} in\n${e1}`);
    }
    assert.ok(e1.endsWith("# Epic\n\nKeep this body.\n"));

    const s9 = ws.read(S9);
    assert.match(s9, /^---\ncard_id: "APP-S9"\ntitle: "New from board"\nstatus: "Backlog"\ntype: "Story"\npriority: "Low"\n/);
    assert.match(s9, /story_points: 2\n/);
    assert.ok(s9.trimEnd().endsWith("Created on the board"));
    assert.equal(ws.read(S1), before.s1, "unchanged card is not rewritten");
    assert.equal(ws.read(BAD), before.bad);
    assert.ok(!ws.exists(".github/cards/stories/APP-ZERO.md"));
    assert.ok(!ws.exists(".github/cards/_examples/EXAMPLE-1.md"));
    assert.deepEqual(run.state.log, [], "reverse never writes to GitHub");

    for (const line of [
      "Direction: reverse (GitHub -> Markdown)",
      "Ignored 1 remote kit sample issue(s) (EXAMPLE/TEMPLATE/SAMPLE — not mapped for sync).",
      "Issues mapped: 6",
      "Project fields loaded: owner=acme number=1 (3 item(s))",
      `Patched: ${E1} (issue #1)`,
      `Created: ${S9} (issue #3)`,
      `SKIP (invalid frontmatter): ${BAD} (issue #5)`,
      "Unchanged: 1 card(s) (frontmatter already matches board).",
      "GitHub reverse sync wrote: 2 file(s)",
      "Skipped: 1 issue(s).",
    ]) {
      assert.ok(run.logs.includes(line), `missing log: ${line}\n${run.stdout}`);
    }
  });
});

test("reverse dry-run reports the patches and creations it would make without touching files", () => {
  withWorkspace(reverseWorkspace(), (ws) => {
    const before = ws.read(E1);
    const run = runSync(ws, [], { state: reverseState(), env: { SYNC_DIRECTION: "reverse", DRY_RUN: "true" } });
    assert.equal(run.status, 0, run.output);
    assert.equal(ws.read(E1), before);
    assert.ok(!ws.exists(S9));
    assert.ok(run.logs.includes("Dry-run: yes"));
    assert.ok(run.logs.includes(`Would patch frontmatter: ${E1} (issue #1)`));
    assert.ok(run.logs.includes(`Would create: ${S9} (issue #3)`));
    assert.ok(!run.logs.some((l) => l.startsWith("GitHub reverse sync wrote")));
  });
});

test("reverse without a usable Project falls back to issue metadata (and CI can require the Project)", () => {
  withWorkspace(reverseWorkspace(projectsMap()), (ws) => {
    const run = runSync(ws, ["--reverse"], { state: reverseState() });
    assert.equal(run.status, 0, run.output);
    assert.ok(run.logs.includes("No projectNumber configured — reverse will use issue metadata only (no board fields)."));
    const e1 = ws.read(E1);
    assert.match(e1, /\nstatus: "Backlog"\n/, "no board value and no STATUS metadata keeps the local status");
    assert.match(e1, /\ncategories:\n {2}- "Backend"\n/, "labels still flow back");
    assert.ok(!run.calls.some((c) => c.body.query.includes("projectV2(number")));

    const ci = runSync(ws, ["--reverse"], { state: reverseState(), env: { CARDS_CI_REQUIRE_PROJECT: "true" } });
    assert.equal(ci.status, 1);
    assert.match(ci.stderr, /FATAL ERROR[\s\S]*projectNumber required for CI reverse \(board pull\)/);
  });
  withWorkspace(reverseWorkspace(projectsMap({ projectNumber: 5 })), (ws) => {
    const run = runSync(ws, ["--reverse"], { state: reverseState(), env: { PROJECT_SYNC_TOKEN: undefined, GITHUB_TOKEN: "actions-token" } });
    assert.equal(run.status, 0, run.output);
    assert.ok(run.logs.includes("Project #5 not found — reverse will use issue metadata only."));
    assert.ok(run.calls.every((c) => c.headers.Authorization === "Bearer actions-token"));
  });
});

test("reverse with no mapped issues says so and writes nothing", () => {
  withWorkspace(reverseWorkspace(), (ws) => {
    const run = runSync(ws, ["--reverse"], { state: { issues: [{ id: "I_1", number: 1, title: "untracked", body: "no metadata", state: "OPEN", author: { login: "dependabot[bot]" } }] } });
    assert.equal(run.status, 0, run.output);
    assert.ok(run.logs.includes("No issues with CARD_ID found."));
  });
});

test("reverse dispatches to the configured backend and fails fast on missing repository or token", () => {
  for (const [backend, message] of [
    ["jira", /Jira backend requires/],
    ["azure", /Azure DevOps backend requires/],
    ["gitlab", /GitLab backend requires/],
    ["linear", /Linear backend requires/],
  ]) {
    withWorkspace(makeWorkspace({ config: projectsMap({ backend }) }), (ws) => {
      const run = runSync(ws, ["--reverse"]);
      assert.equal(run.status, 1, backend);
      assert.match(run.stderr, message);
      assert.doesNotMatch(run.stderr, /FATAL/);
    });
  }
  withWorkspace(makeWorkspace(), (ws) => {
    const noCli = { PROJECT_SYNC_TOKEN: undefined, GITHUB_REPOSITORY: undefined, Path: undefined, PATH: fakeBin(ws) };
    const noRepo = runSync(ws, ["--reverse"], { env: noCli });
    assert.equal(noRepo.status, 1);
    assert.match(noRepo.stderr, /FATAL ERROR\r?\nError: GITHUB_REPOSITORY not set\./);
    const noToken = runSync(ws, ["--reverse"], { env: { ...noCli, GITHUB_REPOSITORY: "acme/app" } });
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /Error: Token missing\./);
  });
});

test("applyReverseCardFileUpdate covers skip, patch and create outcomes for every backend", async () => {
  inProcess.write(".github/cards/stories/LOCAL-1.md", card({ id: "LOCAL-1", status: "Backlog" }));
  const converted = (cardId, sourceFile, status = "Done") => ({
    sourceFile,
    markdown: `---\ncard_id: "${cardId}"\ntitle: "From remote"\nstatus: "${status}"\ntype: "Task"\ncategories: []\n---\n\nRemote body\n`,
  });

  const logs = await captureLogs(async () => {
    assert.deepEqual(await applyReverseCardFileUpdate({ sourceFile: null, cardId: "X" }), { kind: "skipped", reason: "no_source_file" });
    assert.deepEqual(await applyReverseCardFileUpdate({ sourceFile: ".github/cards/stories/SAMPLE-1.md", cardId: "SAMPLE-1" }), { kind: "skipped_sample" });
    assert.deepEqual(await applyReverseCardFileUpdate({ sourceFile: ".github/cards/stories/NOPE.md", cardId: "NOPE", logLabel: " (remote)" }), {
      kind: "skipped",
      reason: "no_local_no_convert",
    });
    assert.deepEqual(
      await applyReverseCardFileUpdate({ sourceFile: ".github/cards/stories/BROKEN.md", cardId: "BROKEN", converted: { sourceFile: ".github/cards/stories/BROKEN.md", markdown: "not a card" } }),
      { kind: "skipped", reason: "invalid_convert" }
    );

    const patched = await applyReverseCardFileUpdate({
      sourceFile: ".github/cards/stories/LOCAL-1.md",
      cardId: "LOCAL-1",
      remoteUpdates: { status: "In Progress" },
      converted: converted("LOCAL-1", ".github/cards/stories/LOCAL-1.md"),
    });
    assert.deepEqual(patched, { kind: "patched", path: ".github/cards/stories/LOCAL-1.md" });
    assert.equal(countReverseWrite(patched), 1);
    const local = inProcess.read(".github/cards/stories/LOCAL-1.md");
    assert.match(local, /\nstatus: "In Progress"\n/, "explicit remote update wins over the converted markdown");
    assert.match(local, /\ntype: "Task"\n/, "converted markdown fills fields the remote didn't send");

    const again = await applyReverseCardFileUpdate({ sourceFile: ".github/cards/stories/LOCAL-1.md", cardId: "LOCAL-1", remoteUpdates: { status: "In Progress" } });
    assert.deepEqual(again, { kind: "unchanged", path: ".github/cards/stories/LOCAL-1.md" });
    assert.equal(countReverseWrite(again), 0);

    const created = await applyReverseCardFileUpdate({
      sourceFile: ".github/cards/tasks/NEW-1.md",
      cardId: "NEW-1",
      remoteUpdates: { priority: "Low" },
      converted: { sourceFile: ".github/cards/tasks/NEW-1.md", markdown: '---\ntitle: "No id in markdown"\nstatus: "Done"\n---\n\nRemote body\n' },
    });
    assert.deepEqual(created, { kind: "created", path: ".github/cards/tasks/NEW-1.md" });
    assert.equal(countReverseWrite(created), 1);
    const written = inProcess.read(".github/cards/tasks/NEW-1.md");
    assert.match(written, /^---\ncard_id: "NEW-1"\ntitle: "No id in markdown"\nstatus: "Done"\n/);
    assert.match(written, /\npriority: "Low"\n/);
  });
  assert.ok(logs.includes("[cards-sync] SKIP (no local card, invalid metadata): .github/cards/stories/NOPE.md (remote)"));
  assert.ok(logs.includes("[cards-sync] Patched: .github/cards/stories/LOCAL-1.md"));
  assert.ok(logs.includes("[cards-sync] Created: .github/cards/tasks/NEW-1.md"));
});
