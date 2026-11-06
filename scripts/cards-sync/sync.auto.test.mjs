import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { setupWorkspace } from "./backends/sync-fixture.mjs";
import { card, fakeBin, issueBody, issueByCard, makeWorkspace, project, projectsMap, runSync, selectField } from "./fixtures/sync-harness.mjs";

const HAS_GIT = spawnSync("git", ["--version"]).status === 0;

function git(cwd, ...args) {
  const run = spawnSync("git", ["-c", "user.name=Hyperion Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

function initRepo(root) {
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "cards");
}

// In-process half: sync.mjs binds its workspace to process.cwd() at load time.
const inProcess = setupWorkspace({
  "stories/H-1.md": card({ id: "H-1" }),
  "stories/H-2.md": card({ id: "H-2" }),
  "stories/H-3.md": card({ id: "H-3" }),
});
const { readGitCardHistory, remoteViewFromIssue } = await import("./sync.mjs");
test.after(() => inProcess.cleanup());

const S = (id) => `.github/cards/stories/${id}.md`;
const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";
const STATUS_FIELD = selectField("F_status", "Status", ["Backlog", "Done", "Review"]);
const statusValue = (name) => ({ F_status: { singleSelectOptionId: STATUS_FIELD.options.find((o) => o.name === name).id } });

function remoteIssue(number, cardId, { title = `[Story] Card ${cardId}`, state = "OPEN", updatedAt = PAST, sourceFile = cardId ? S(cardId) : null, meta = {}, author = "dev" } = {}) {
  return { id: `I_${number}`, number, title, body: cardId ? issueBody({ cardId, sourceFile, meta }) : "no metadata", state, updatedAt, author: { login: author }, labels: [] };
}

function withWorkspace(ws, fn) {
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

test("readGitCardHistory reports last commit per card, local edits and deletions", { skip: !HAS_GIT && "git not available" }, () => {
  initRepo(inProcess.root);
  rmSync(inProcess.path(".github/cards/stories/H-3.md"));
  git(inProcess.root, "commit", "-q", "--no-verify", "-am", "drop H-3");
  inProcess.write(".github/cards/stories/H-1.md", card({ id: "H-1", status: "Done" }));
  inProcess.write(".github/cards/stories/H-4.md", card({ id: "H-4" }));

  const history = readGitCardHistory(".github/cards");
  assert.deepEqual([...history.committed.keys()].sort(), [S("H-1"), S("H-2"), S("H-3")]);
  assert.ok([...history.committed.values()].every((when) => !Number.isNaN(Date.parse(when))));
  assert.deepEqual([...history.dirty].sort(), [S("H-1"), S("H-4")]);
  assert.deepEqual([...history.deleted], [S("H-3")]);
});

test("remoteViewFromIssue prefers board values and falls back to SYNC_METADATA", () => {
  const issue = remoteIssue(4, "R-1", { title: "[Task] Ship it", meta: { STATUS: "Done", PRIORITY: "High", STORY_POINTS: "3", PARENT_CARD_ID: "R-0", DUE_DATE: "2026-01-01" } });
  const view = remoteViewFromIssue(issue, { status: "Review", sprint: "Sprint 2" }, {});
  assert.deepEqual(
    { ...view, issue: undefined },
    {
      title: "Ship it",
      status: "Review",
      type: "Task",
      priority: "High",
      sprint: "Sprint 2",
      storyPoints: "3",
      reporter: null,
      parent: "R-0",
      dueDate: "2026-01-01",
      state: "OPEN",
      issueNumber: 4,
      sourceFile: S("R-1"),
      updatedAt: PAST,
      issue: undefined,
    }
  );
  const bare = remoteViewFromIssue({ number: 9, title: "plain title", body: "" });
  assert.equal(bare.title, "plain title");
  assert.equal(bare.status, null);
  assert.equal(bare.sourceFile, null);
});

test("auto (first run) classifies every card, reconciles both sides and writes the snapshot + report", { skip: !HAS_GIT && "git not available" }, () => {
  const cards = {
    "stories/APP-1.md": card({ id: "APP-1", status: "Backlog" }),
    "stories/APP-2.md": card({ id: "APP-2", status: "Backlog" }),
    "stories/APP-3.md": card({ id: "APP-3", status: "Backlog" }),
    "stories/APP-7.md": card({ id: "APP-7" }),
    "stories/APP-8.md": card({ id: "APP-8", title: "Local title", status: "Backlog" }),
  };
  withWorkspace(makeWorkspace({ cards, config: projectsMap({ projectNumber: 1 }) }), (ws) => {
    initRepo(ws.root);
    rmSync(ws.path(S("APP-7")));
    git(ws.root, "commit", "-q", "--no-verify", "-am", "remove APP-7");

    const state = {
      projects: [
        project({
          fields: [STATUS_FIELD],
          views: [],
          items: [
            { id: "PVTI_a1", issueId: "I_1", values: statusValue("Backlog") },
            { id: "PVTI_a3", issueId: "I_3", values: statusValue("Done") },
            { id: "PVTI_a8", issueId: "I_8", values: statusValue("Done") },
          ],
        }),
      ],
      issues: [
        remoteIssue(1, "APP-1"),
        remoteIssue(20, "APP-1", { state: "CLOSED" }),
        remoteIssue(3, "APP-3", { updatedAt: FUTURE }),
        remoteIssue(4, "APP-4", { meta: { STATUS: "Backlog" } }),
        remoteIssue(5, "APP-5", { title: "[Task] Five", sourceFile: null }),
        remoteIssue(6, "APP-6", { state: "CLOSED" }),
        remoteIssue(7, "APP-7"),
        remoteIssue(8, "APP-8", { title: "[Story] Remote title", updatedAt: FUTURE }),
        remoteIssue(30, null, { title: "Human bug report" }),
        remoteIssue(31, null, { title: "Bump deps", author: "github-actions" }),
        remoteIssue(32, null, { title: "Old closed", state: "CLOSED" }),
      ],
    };
    const run = runSync(ws, ["--auto"], { state });
    assert.equal(run.status, 0, run.output);

    assert.match(ws.read(S("APP-3")), /\nstatus: "Done"\n/, "board-owned status flows back when the issue is newer");
    assert.match(ws.read(S("APP-8")), /\ntitle: "Local title"\nstatus: "Done"\n/, "merge keeps git's title and the board's status");
    assert.match(ws.read(S("APP-4")), /^---\ncard_id: "APP-4"\n/);
    assert.match(ws.read(".github/cards/tasks/_orphan/APP-5.md"), /^---\ncard_id: "APP-5"\ntitle: "Five"\nstatus: null\ntype: "Task"\n/);
    assert.ok(!ws.exists(S("APP-7")), "a card deleted in git is never resurrected");
    assert.ok(!ws.exists(S("APP-6")));

    const issues = run.state.issues;
    assert.equal(issueByCard(run.state, "APP-2").title, "[Story] Card APP-2");
    assert.equal(issues.find((i) => i.number === 8).title, "[Story] Local title");
    assert.equal(issues.filter((i) => i.title.startsWith("[")).length, 9, "only APP-2 was created");
    assert.equal(run.state.comments.length, 1);
    assert.equal(run.state.comments[0].id, "I_20");
    assert.match(run.state.comments[0].body, /^<!-- hyperion-duplicate-of:#1 -->\n/);

    const snapshot = ws.readJson(".github/plans/cards/last-state.json");
    assert.deepEqual(snapshot.commentedDuplicates, ["APP-1:#20"]);
    assert.deepEqual(snapshot.tombstones, ["APP-7"]);
    assert.deepEqual(snapshot.failedCardIds, []);
    assert.deepEqual(Object.keys(snapshot.cards).sort(), ["APP-1", "APP-2", "APP-3", "APP-4", "APP-5", "APP-8"]);
    assert.equal(snapshot.cards["APP-3"].status, "Done");

    const report = ws.read(".github/plans/cards/last-reconcile.md");
    assert.match(report, /- `APP-1` .*#20/);
    assert.match(report, /- `APP-6` #6 Card APP-6/);
    assert.match(report, /- `APP-7` #7 Card APP-7/);
    assert.match(report, /- #30 Human bug report/);
    assert.doesNotMatch(report, /#31|#32/);

    for (const line of [
      "Direction: auto (reconcile markdown <-> GitHub Issues/Project)",
      "1 CARD_ID(s) with duplicate issues — canonical kept, extras commented once, never deleted.",
      "Commented duplicate #20 → canonical #1 (hyperion-duplicate-of)",
      "1 open issue(s) without CARD_ID (listed in last-reconcile.md, not imported).",
      "Plan skip=1 forward=1 reverse=1 reverse_create=2 remote_only_closed=1 deleted_locally=1 merge=1".split(" ").sort().join(" "),
      "No last-state.json yet — board status/sprint only flow back when the issue is newer than the card's last commit.",
      `Created: ${S("APP-4")} (issue #4, created from board)`,
      "Created: .github/cards/tasks/_orphan/APP-5.md (issue #5, created from board)",
      `Reconciled ${S("APP-3")} (reverse: status)`,
      `Reconciled ${S("APP-8")} (merge: status)`,
      "Incremental sync: 2 target(s) → 2 card(s) including parents",
      "1 card(s) deleted in git still have issues — not recreated (close them on the board).",
    ]) {
      const found = line.startsWith("Plan") ? run.logs.some((l) => l.startsWith("Plan") && l.split(" ").sort().join(" ") === line) : run.logs.includes(line);
      assert.ok(found, `missing log: ${line}\n${run.stdout}`);
    }
    assert.ok(run.logs.some((l) => /^Wrote .+last-state\.json and .+last-reconcile\.md$/.test(l)));
  });
});

test("auto with a snapshot resolves same-field conflicts by ownership, retries failed pushes and never re-comments", () => {
  const cards = {
    "stories/APP-2.md": card({ id: "APP-2" }),
    "stories/APP-3.md": card({ id: "APP-3", title: "Local title", status: "Done" }),
  };
  const previous = {
    when: "2026-01-01T00:00:00.000Z",
    failedCardIds: [],
    commentedDuplicates: ["APP-1:#20"],
    tombstones: ["APP-9"],
    cards: {
      "APP-2": { title: "Card APP-2", status: null, type: "Story", sprint: null, priority: null, storyPoints: null, reporter: null, parent: null, dueDate: null, sourceFile: S("APP-2") },
      "APP-3": { title: "Old title", status: "Backlog", type: "Story", sprint: null, priority: null, storyPoints: null, reporter: null, parent: null, dueDate: null, sourceFile: S("APP-3") },
    },
  };
  const files = { ".github/plans/cards/last-state.json": JSON.stringify(previous) };
  withWorkspace(makeWorkspace({ cards, files, config: projectsMap({ projectNumber: 1, locale: "en" }) }), (ws) => {
    const state = {
      projects: [project({ fields: [STATUS_FIELD], views: [], items: [{ id: "PVTI_3", issueId: "I_3", values: statusValue("Review") }] })],
      issues: [
        remoteIssue(1, "APP-1", { sourceFile: S("APP-1") }),
        remoteIssue(20, "APP-1"),
        remoteIssue(3, "APP-3", { title: "[Story] Remote title" }),
        remoteIssue(5, "APP-5", { state: "CLOSED" }),
        remoteIssue(50, "APP-5", { state: "CLOSED" }),
        remoteIssue(9, "APP-9"),
      ],
      fail: { addComment: true, createIssue: ["Card APP-2"] },
    };
    const run = runSync(ws, ["--auto"], { state, env: { PROJECT_SYNC_TOKEN: "project-token", GITHUB_TOKEN: "actions-token" } });
    assert.equal(run.status, 0, run.output);

    assert.match(ws.read(S("APP-3")), /\ntitle: "Local title"\nstatus: "Review"\n/);
    const issue3 = run.state.issues.find((i) => i.number === 3);
    assert.equal(issue3.title, "[Story] Local title");
    assert.deepEqual(run.state.projects[0].items[0].values, statusValue("Review"));

    const writes = run.state.log;
    assert.ok(writes.filter((m) => ["updateIssue", "createIssue", "addComment"].includes(m.op)).every((m) => m.auth === "Bearer actions-token"), "issue writes use the Actions token");
    assert.ok(writes.filter((m) => m.op === "setFieldValue").every((m) => m.auth === "Bearer project-token"), "project writes keep the project token");
    assert.ok(!writes.some((m) => m.op === "addComment" && m.id === "I_20"), "already-commented duplicate is skipped");

    const snapshot = ws.readJson(".github/plans/cards/last-state.json");
    assert.deepEqual(snapshot.failedCardIds, ["APP-2"]);
    assert.deepEqual(snapshot.cards["APP-2"], previous.cards["APP-2"], "failed card keeps its previous snapshot so it retries");
    assert.equal(snapshot.cards["APP-3"].status, "Review");
    assert.deepEqual(snapshot.tombstones, ["APP-9"]);
    assert.deepEqual(snapshot.commentedDuplicates, ["APP-1:#20"]);

    const report = ws.read(".github/plans/cards/last-reconcile.md");
    assert.match(report, /- `APP-3`\.status: git=`Done` board=`Review` kept=`Review` \(board\)/);
    assert.match(report, /- `APP-3`\.title: git=`Local title` board=`Remote title` kept=`Local title` \(git\)/);
    assert.match(report, /- `APP-2`\n/);
    assert.match(report, /- `APP-9` #9 Card APP-9/);

    for (const line of [
      "CONFLICT APP-3.status: git=Done board=Review kept=Review (board)",
      "CONFLICT APP-3.title: git=Local title board=Remote title kept=Local title (git)",
      `Reconciled ${S("APP-3")} (merge: status)`,
      "Forward incomplete for 1 card(s); snapshot keeps their previous state so they retry.",
      "2 field conflict(s); owner applied (board = status/sprint, git = the rest).",
    ]) {
      assert.ok(run.logs.includes(line), `missing log: ${line}\n${run.stdout}`);
    }
    assert.ok(run.logs.some((l) => l.startsWith("Could not comment duplicate #50: GraphQL failed")));
    assert.ok(run.logs.some((l) => l.startsWith("Could not comment duplicate #20: GraphQL failed")) === false);
  });
});

test("auto run twice with nothing new leaves the snapshot alone", () => {
  const cards = { "stories/APP-1.md": card({ id: "APP-1", title: "Same", status: "Backlog", type: "Story", priority: "High", storyPoints: 3 }) };
  withWorkspace(makeWorkspace({ cards, config: projectsMap({ projectNumber: 1 }) }), (ws) => {
    const state = {
      projects: [project({ fields: [STATUS_FIELD], items: [{ id: "PVTI_1", issueId: "I_1", values: statusValue("Backlog") }] })],
      issues: [remoteIssue(1, "APP-1", { title: "[Story] Same", meta: { PRIORITY: "High", STORY_POINTS: "3" } })],
    };
    const first = runSync(ws, ["--auto"], { state });
    assert.equal(first.status, 0, first.output);
    const written = ws.read(".github/plans/cards/last-state.json");
    assert.ok(first.logs.includes("No forward push needed."));
    const second = runSync(ws, ["--auto"], { state: first.state });
    assert.equal(second.status, 0, second.output);
    assert.ok(second.logs.some((l) => /^Snapshot unchanged — .+last-state\.json not rewritten\.$/.test(l)), second.stdout);
    assert.equal(ws.read(".github/plans/cards/last-state.json"), written);
    assert.deepEqual(second.state.log, []);
  });
});

test("auto --dry-run plans everything but writes nothing", () => {
  const cards = {
    "stories/APP-2.md": card({ id: "APP-2" }),
    "stories/APP-3.md": card({ id: "APP-3", status: "Backlog" }),
  };
  withWorkspace(makeWorkspace({ cards }), (ws) => {
    const state = {
      issues: [
        remoteIssue(1, "APP-1"),
        remoteIssue(20, "APP-1"),
        remoteIssue(3, "APP-3", { updatedAt: FUTURE, meta: { STATUS: "Done" } }),
        remoteIssue(4, "APP-4"),
        remoteIssue(5, "APP-5", { sourceFile: null }),
      ],
    };
    const run = runSync(ws, ["--auto", "--dry-run"], { state });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.state.log, []);
    assert.match(ws.read(S("APP-3")), /\nstatus: "Backlog"\n/);
    assert.ok(!ws.exists(S("APP-1")) && !ws.exists(S("APP-4")) && !ws.exists(".github/plans/cards/last-state.json"));
    for (const line of [
      "Dry-run: yes",
      "No projectNumber configured — status/sprint come from issue metadata only.",
      "Would comment duplicate #20 → canonical #1",
      `Would create: ${S("APP-1")} (issue #1, created from board)`,
      "Would create: .github/cards/stories/_orphan/APP-5.md (issue #5, created from board)",
      `Would reconcile ${S("APP-3")} (reverse: status)`,
      "=== DRY-RUN REPORT ===",
    ]) {
      assert.ok(run.logs.includes(line), `missing log: ${line}\n${run.stdout}`);
    }
    assert.ok(run.logs.some((l) => /^Dry-run: would write .+last-state\.json and .+last-reconcile\.md$/.test(l)));
  });
});

test("auto warns about the Actions-only token and records an aborted forward push as failed", () => {
  withWorkspace(makeWorkspace({ cards: { "stories/APP-2.md": card({ id: "APP-2" }) }, config: projectsMap({ projectNumber: 7 }) }), (ws) => {
    const run = runSync(ws, ["--auto"], {
      state: { fail: { repoId: true } },
      env: { GITHUB_ACTIONS: "true", PROJECT_SYNC_TOKEN: undefined, GITHUB_TOKEN: "actions-token" },
    });
    assert.equal(run.status, 0, run.output);
    const warning = "PROJECT_SYNC_TOKEN missing — org/user Project updates usually fail with GITHUB_TOKEN";
    assert.ok(run.logs.includes(`WARN: ${warning}`));
    assert.ok(run.logs.includes("Project #7 not found — board fields fall back to issue metadata."));
    assert.ok(run.logs.some((l) => l.startsWith("Forward aborted: GraphQL failed")));
    assert.ok(run.logs.includes("Forward incomplete for 1 card(s); snapshot keeps their previous state so they retry."));
    assert.deepEqual(ws.readJson(".github/plans/cards/last-state.json").failedCardIds, ["APP-2"]);
    assert.ok(ws.read(".github/plans/cards/last-reconcile.md").includes(warning));
  });
});

test("auto on a non-GitHub backend runs a forward sync; auto without credentials fails fast", () => {
  withWorkspace(makeWorkspace({ cards: { "stories/APP-1.md": card({ id: "APP-1" }) }, config: projectsMap({ backend: "linear" }) }), (ws) => {
    const run = runSync(ws, ["--auto"]);
    assert.equal(run.status, 1);
    assert.ok(run.logs.includes("Auto reconcile supports the GitHub backend only (backend: linear) — running forward sync."));
    assert.match(run.stderr, /Linear backend requires/);
  });
  withWorkspace(makeWorkspace({ cards: { "stories/APP-1.md": card({ id: "APP-1" }) } }), (ws) => {
    const noCli = { PROJECT_SYNC_TOKEN: undefined, Path: undefined, PATH: fakeBin(ws) };
    const offline = runSync(ws, ["--auto", "--dry-run"], { env: noCli });
    assert.equal(offline.status, 0, offline.output);
    assert.equal(offline.calls.length, 0);
    assert.ok(offline.logs.includes("=== DRY-RUN REPORT ==="));

    const noToken = runSync(ws, [], { env: { ...noCli, SYNC_DIRECTION: "auto" } });
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /Error: Token missing\./);

    const noRepo = runSync(ws, ["--auto"], { env: { ...noCli, GITHUB_REPOSITORY: undefined } });
    assert.equal(noRepo.status, 1);
    assert.match(noRepo.stderr, /Error: GITHUB_REPOSITORY not set\./);
  });
});
