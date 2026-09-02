import test from "node:test";
import assert from "node:assert/strict";
import {
  boardLabel,
  printBoardDriftHelp,
  evaluateBoardAlignment,
  detectExternalDriftFields,
  normalizeSyncFieldValue,
  parseFrontmatterForGuard,
} from "./board-guard.mjs";

test("boardLabel maps backend names", () => {
  assert.equal(boardLabel("github"), "GitHub Project board");
  assert.equal(boardLabel("linear"), "Linear board");
  assert.equal(boardLabel("jira"), "Jira board");
});

test("detectExternalDriftFields allows forward-pending status change", () => {
  const head = { status: "Done" };
  const base = { status: "In Progress" };
  const board = { status: "In Progress" };
  assert.deepEqual(detectExternalDriftFields(head, base, board), []);
});

test("detectExternalDriftFields blocks external board status move", () => {
  const head = { status: "In Progress" };
  const base = { status: "In Progress" };
  const board = { status: "Done" };
  const drifts = detectExternalDriftFields(head, base, board);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].field, "status");
  assert.equal(drifts[0].board, "Done");
});

test("detectExternalDriftFields allows new card field on PR branch", () => {
  const head = { status: "Done" };
  const base = {};
  const board = { status: "In Progress" };
  assert.deepEqual(detectExternalDriftFields(head, base, board), []);
});

test("normalizeSyncFieldValue sorts categories", () => {
  assert.equal(normalizeSyncFieldValue("categories", ["B", "A"]), "A|B");
});

test("evaluateBoardAlignment passes when no external drift", () => {
  const result = evaluateBoardAlignment(
    { aligned: true, files: [], externalDrifts: [], gitAvailable: true },
    { backend: "github", context: "pr", logFn: () => {} }
  );
  assert.equal(result.ok, true);
});

test("evaluateBoardAlignment fails on external drift in PR context", () => {
  const lines = [];
  const result = evaluateBoardAlignment(
    {
      aligned: false,
      files: [".github/cards/stories/X.md"],
      externalDrifts: [{ file: ".github/cards/stories/X.md", fields: [{ field: "status", head: "In Progress", board: "Done" }] }],
      gitAvailable: true,
    },
    { backend: "github", context: "pr", logFn: (m) => lines.push(m) }
  );
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => l.includes("Forward-pending")));
  assert.ok(lines.some((l) => l.includes("cards:reverse")));
});

test("evaluateBoardAlignment strict git fails when git unavailable", () => {
  const prev = process.env.CARDS_CI_STRICT_GIT;
  process.env.CARDS_CI_STRICT_GIT = "true";
  try {
    const result = evaluateBoardAlignment(
      { aligned: true, files: [], warning: "no git", skipped: true },
      { backend: "github", context: "pr", logFn: () => {} }
    );
    assert.equal(result.ok, false);
  } finally {
    if (prev === undefined) delete process.env.CARDS_CI_STRICT_GIT;
    else process.env.CARDS_CI_STRICT_GIT = prev;
  }
});

test("printBoardDriftHelp includes push instruction for PR context", () => {
  const lines = [];
  printBoardDriftHelp([".github/cards/epics/A.md"], "github", "pr", (m) => lines.push(m));
  assert.ok(lines.some((l) => l.includes("git push")));
});

test("detectExternalDriftFields detects board_sync_at external drift", () => {
  const head = { board_sync_at: "2026-01-01T00:00:00.000Z" };
  const base = { board_sync_at: "2026-01-01T00:00:00.000Z" };
  const board = { board_sync_at: "2026-01-02T00:00:00.000Z" };
  const drifts = detectExternalDriftFields(head, base, board);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].field, "board_sync_at");
});

test("detectExternalDriftFields allows forward-pending board_sync_at on PR", () => {
  const head = { board_sync_at: "2026-01-02T00:00:00.000Z" };
  const base = { board_sync_at: "2026-01-01T00:00:00.000Z" };
  const board = { board_sync_at: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(detectExternalDriftFields(head, base, board), []);
});

test("parseFrontmatterForGuard reads status", () => {
  const meta = parseFrontmatterForGuard(`---
status: "Done"
card_id: "X-1"
---
# Body
`);
  assert.equal(meta.status, "Done");
  assert.equal(meta.card_id, "X-1");
});
