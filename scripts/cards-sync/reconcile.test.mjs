import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReconcilePlan,
  classifyCard,
  composeSnapshotCards,
  composeTombstones,
  detectDuplicateIssues,
  diffFields,
  duplicateCommentBody,
  isRemoteNewer,
  mergeCardFields,
  parseLastSyncWhen,
  pickCanonicalIssueFromGroup,
  renderReconcileReport,
  snapshotFromCard,
  snapshotStateChanged,
} from "./reconcile.mjs";

const OLD = "2026-01-01T00:00:00Z";
const NEW = "2026-02-01T00:00:00Z";

function card(overrides = {}) {
  return {
    cardId: "APP-TASK-001",
    title: "Do the thing",
    type: "Task",
    priority: "P1",
    storyPoints: "3",
    status: "To Do",
    sprint: "Sprint 1",
    updatedAt: OLD,
    ...overrides,
  };
}

test("classifyCard: identical sides skip", () => {
  assert.equal(classifyCard({ local: card(), remote: card() }), "skip");
});

test("classifyCard: local only forwards, remote only (open) reverse-creates", () => {
  assert.equal(classifyCard({ local: card(), remote: null }), "forward");
  assert.equal(classifyCard({ local: null, remote: card({ state: "OPEN" }) }), "reverse_create");
});

test("classifyCard never resurrects a card known to the snapshot or deleted in git", () => {
  const remote = card({ state: "OPEN" });
  assert.equal(classifyCard({ local: null, remote, snapshot: snapshotFromCard(card()) }), "deleted_locally");
  assert.equal(classifyCard({ local: null, remote, deletedLocally: true }), "deleted_locally");
});

test("classifyCard reports closed remote-only issues instead of recreating them", () => {
  assert.equal(classifyCard({ local: null, remote: card({ state: "CLOSED" }) }), "remote_only_closed");
  assert.equal(classifyCard({ local: null, remote: { ...card(), issue: { state: "CLOSED" } } }), "remote_only_closed");
});

test("without snapshot, board fields flow back only when the issue is newer", () => {
  const local = card({ updatedAt: NEW });
  const staleRemote = card({ status: "Done", updatedAt: OLD });
  assert.equal(classifyCard({ local, remote: staleRemote }), "skip");

  const freshRemote = card({ status: "Done", updatedAt: "2026-03-01T00:00:00Z" });
  assert.equal(classifyCard({ local, remote: freshRemote }), "reverse");
});

test("without snapshot, git-owned field differences forward", () => {
  assert.equal(classifyCard({ local: card({ title: "New title" }), remote: card() }), "forward");
});

test("with snapshot, one-sided changes flow to the other side", () => {
  const snapshot = snapshotFromCard(card());
  assert.equal(classifyCard({ local: card({ priority: "P0" }), remote: card(), snapshot }), "forward");
  assert.equal(classifyCard({ local: card(), remote: card({ sprint: "Sprint 2" }), snapshot }), "reverse");
  assert.equal(
    classifyCard({ local: card({ priority: "P0" }), remote: card({ status: "Done" }), snapshot }),
    "merge"
  );
});

test("mergeCardFields: dual edit follows ownership (board=status, git=title)", () => {
  const snapshot = snapshotFromCard(card());
  const local = card({ title: "Git title", status: "In Progress" });
  const remote = card({ title: "Board title", status: "Done" });
  const { next, conflicts } = mergeCardFields({ local, remote, snapshot });
  assert.equal(next.title, "Git title");
  assert.equal(next.status, "Done");
  const byField = Object.fromEntries(conflicts.map((c) => [c.field, c.winner]));
  assert.deepEqual(byField, { status: "board", title: "git" });
});

test("mergeCardFields applies one-sided changes without conflicts", () => {
  const snapshot = snapshotFromCard(card());
  const { next, conflicts, applied } = mergeCardFields({
    local: card({ priority: "P0" }),
    remote: card({ sprint: "Sprint 2" }),
    snapshot,
  });
  assert.equal(next.priority, "P0");
  assert.equal(next.sprint, "Sprint 2");
  assert.equal(conflicts.length, 0);
  assert.deepEqual(applied.map((a) => `${a.field}:${a.from}`).sort(), ["priority:git", "sprint:board"]);
});

test("diffFields treats empty/null/'null' as equal", () => {
  const diffs = diffFields({ local: card({ dueDate: "" }), remote: card({ dueDate: "null" }) });
  assert.equal(diffs.find((d) => d.field === "dueDate").gitChanged, false);
});

test("isRemoteNewer is false when a timestamp is missing", () => {
  assert.equal(isRemoteNewer({ updatedAt: OLD }, {}), false);
  assert.equal(isRemoteNewer({ updatedAt: OLD }, { updatedAt: NEW }), true);
});

test("pickCanonicalIssueFromGroup prefers open, then lowest number", () => {
  const issues = [
    { number: 3, state: "OPEN" },
    { number: 1, state: "CLOSED" },
    { number: 7, state: "OPEN" },
  ];
  assert.equal(pickCanonicalIssueFromGroup(issues).number, 3);
  assert.equal(pickCanonicalIssueFromGroup([]), null);
});

test("detectDuplicateIssues keeps canonical and sorts extras", () => {
  const grouped = new Map([
    ["B-1", [{ number: 9, state: "OPEN" }, { number: 4, state: "OPEN" }, { number: 2, state: "CLOSED" }]],
    ["A-1", [{ number: 5, state: "OPEN" }]],
  ]);
  const dups = detectDuplicateIssues(grouped);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].cardId, "B-1");
  assert.equal(dups[0].keep, 4);
  assert.deepEqual(dups[0].extras, [2, 9]);
});

test("duplicateCommentBody carries an idempotent marker and follows locale", () => {
  const pt = duplicateCommentBody({ cardId: "X-1", keep: 12, locale: "pt-BR" });
  const en = duplicateCommentBody({ cardId: "X-1", keep: 12, locale: "en" });
  assert.match(pt, /<!-- hyperion-duplicate-of:#12 -->/);
  assert.match(pt, /duplicata/);
  assert.match(en, /<!-- hyperion-duplicate-of:#12 -->/);
  assert.match(en, /duplicate/);
});

test("composeSnapshotCards keeps the previous entry for failed forwards", () => {
  const previous = { cards: { "A-1": { title: "old" } } };
  const cards = composeSnapshotCards(
    [card({ cardId: "A-1", title: "new" }), card({ cardId: "A-2", title: "fresh" }), card({ cardId: "A-3" })],
    previous,
    ["A-1", "A-3"]
  );
  assert.deepEqual(cards["A-1"], { title: "old" });
  assert.equal(cards["A-2"].title, "fresh");
  assert.equal("A-3" in cards, false);
});

test("composeTombstones accumulates and drops ids that exist locally again", () => {
  const tombs = composeTombstones({ tombstones: ["A-1", "A-2"] }, ["A-3"], ["A-2"]);
  assert.deepEqual(tombs, ["A-1", "A-3"]);
});

test("snapshotStateChanged ignores `when` and key order", () => {
  const prev = { when: OLD, tombstones: [], cards: { "A-1": { title: "x", status: "Done" } } };
  const same = { cards: { "A-1": { status: "Done", title: "x" } }, tombstones: [], when: NEW };
  assert.equal(snapshotStateChanged(prev, same), false);
  assert.equal(snapshotStateChanged(prev, { ...same, tombstones: ["A-9"] }), true);
  assert.equal(snapshotStateChanged(null, same), true);
});

test("buildReconcilePlan uses tombstones and git deletion to avoid resurrection", () => {
  const remotes = new Map([
    ["T-1", card({ cardId: "T-1", state: "OPEN" })],
    ["G-1", card({ cardId: "G-1", state: "OPEN" })],
    ["N-1", card({ cardId: "N-1", state: "OPEN" })],
    ["S-1", card({ cardId: "S-1" })],
  ]);
  const plan = buildReconcilePlan({
    localCards: [card({ cardId: "S-1" }), card({ cardId: "L-1" })],
    remotes,
    snapshot: { cards: {}, tombstones: ["T-1"] },
    isDeletedInGit: (id) => id === "G-1",
  });
  const byId = Object.fromEntries(plan.items.map((i) => [i.cardId, i.action]));
  assert.deepEqual(byId, {
    "G-1": "deleted_locally",
    "L-1": "forward",
    "N-1": "reverse_create",
    "S-1": "skip",
    "T-1": "deleted_locally",
  });
  assert.equal(plan.counts.deleted_locally, 2);
});

test("renderReconcileReport lists every section and round-trips the timestamp", () => {
  const when = "2026-04-01T12:00:00.000Z";
  const md = renderReconcileReport({
    when,
    counts: { skip: 2, merge: 1 },
    duplicates: [{ cardId: "D-1", keep: 3, extras: [8] }],
    conflicts: [{ cardId: "C-1", field: "status", local: "To Do", remote: "Done", kept: "Done", winner: "board" }],
    orphans: [{ number: 42, title: "loose issue" }],
    failedCardIds: ["F-1"],
    deletedLocally: [{ cardId: "X-1", issueNumber: 5, title: "gone" }],
    remoteOnlyClosed: [],
    tokenWarning: "GITHUB_TOKEN only",
  });
  assert.match(md, /\*\*Plan:\*\* skip=2 merge=1/);
  assert.match(md, /`D-1` canonical #3; extras #8/);
  assert.match(md, /`C-1`\.status: git=`To Do` board=`Done` kept=`Done` \(board\)/);
  assert.match(md, /#42 loose issue/);
  assert.match(md, /`F-1`/);
  assert.match(md, /`X-1` #5 gone/);
  assert.match(md, /## Closed issues without a local card \(not recreated\)\n\nNone\./);
  assert.match(md, /\*\*Token:\*\* GITHUB_TOKEN only/);
  assert.equal(parseLastSyncWhen(md), when);
});

test("renderReconcileReport localizes labels and still round-trips the timestamp", () => {
  const when = "2026-05-02T08:00:00.000Z";
  const md = renderReconcileReport({ when, lang: "pt-BR", duplicates: [{ cardId: "D-1", keep: 3, extras: [8] }] });
  assert.match(md, /^# Último reconcile de cards/);
  assert.match(md, /\*\*Quando:\*\* 2026-05-02/);
  assert.match(md, /`D-1` canônica #3; extras #8/);
  assert.match(md, /## Issues abertas sem CARD_ID\n\nNenhum\./);
  assert.equal(parseLastSyncWhen(md), when);
  assert.equal(parseLastSyncWhen("- **When:** 2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
});

test("duplicateCommentBody renders extra languages collapsed", () => {
  const body = duplicateCommentBody({ cardId: "X-1", keep: 12, languages: ["es", "en"] });
  assert.match(body, /^<!-- hyperion-duplicate-of:#12 -->\n/);
  assert.match(body, /duplicado/);
  assert.match(body, /<details><summary>English<\/summary>\n\nThis issue is a \*\*duplicate\*\*/);
});
