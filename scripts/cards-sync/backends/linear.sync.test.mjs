import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { cardMarkdown, captureLogs, jsonResponse, mockFetch, setupWorkspace } from "./sync-fixture.mjs";

const ws = setupWorkspace();
const { runForwardSyncLinear, runReverseSyncLinear } = await import("./linear.mjs");
const { buildRemoteDescriptionFromCard, parseCardFile } = await import("../lib.mjs");

const management = { linearTeamId: "team-1", linearApiToken: "lin-token", statusMap: { "In progress": "In Progress" } };

function resetCards(cards) {
  rmSync(ws.path(".github/cards"), { recursive: true, force: true });
  for (const [rel, content] of Object.entries(cards)) ws.write(`.github/cards/${rel}`, content);
}

function remoteDescription(rel, content) {
  return buildRemoteDescriptionFromCard(parseCardFile(content, `.github/cards/${rel}`));
}

function actionsFrom(lines) {
  return lines
    .map((l) => l.replace(/^\[cards-sync\] /, ""))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
}

/** GraphQL router: each handler gets (variables, query) and returns `data`. */
function linearApi(handlers) {
  return mockFetch((req) => {
    assert.equal(req.url, "https://api.linear.app/graphql");
    assert.equal(req.headers.Authorization, "lin-token");
    const { query, variables } = req.body;
    for (const [needle, handler] of handlers) {
      if (query.includes(needle)) {
        const data = handler(variables, query);
        return data instanceof Response ? data : { data };
      }
    }
    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  });
}

test.after(() => ws.cleanup());

test("forward and reverse refuse to run without team id and token", async () => {
  await assert.rejects(runForwardSyncLinear({}, {}), /LINEAR_TEAM_ID and LINEAR_API_TOKEN/);
  await assert.rejects(runReverseSyncLinear({}, { linearTeamId: "t" }), /LINEAR_TEAM_ID and LINEAR_API_TOKEN/);
});

test("forward creates new cards, updates existing ones, sets status, labels and parent links", async () => {
  const feature = cardMarkdown({ id: "PROJ-F1", type: "Feature", status: "In progress" });
  const story = cardMarkdown({ id: "PROJ-S1", parent: "PROJ-F1", status: "Done", categories: ["Backend", "Frontend"] });
  resetCards({ "features/PROJ-F1.md": feature, "stories/PROJ-F1/PROJ-S1.md": story });

  const created = [];
  const updates = [];
  const api = linearApi([
    ["labels(first: 200)", () => ({ team: { labels: { nodes: [{ id: "lb-backend", name: "backend" }] } } })],
    ["issueLabelCreate", (v) => ({ issueLabelCreate: { issueLabel: { id: "lb-frontend", name: v.input.name } } })],
    [
      "containsIgnoreCase: $marker",
      (v) => {
        if (v.marker !== "CARD_ID: PROJ-F1") return { team: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } };
        if (!v.after) {
          return { team: { issues: { nodes: [{ id: "other", description: "CARD_ID: PROJ-F10" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } };
        }
        return {
          team: { issues: { nodes: [{ id: "lin-F1", description: remoteDescription("features/PROJ-F1.md", feature) }], pageInfo: { hasNextPage: false } } },
        };
      },
    ],
    ["states {", () => ({ team: { states: { nodes: [{ id: "st-progress", name: "In Progress" }, { id: "st-done", name: "Done" }] } } })],
    [
      "issueCreate",
      (v) => {
        created.push(v.input);
        return { issueCreate: { issue: { id: "lin-S1" } } };
      },
    ],
    [
      "issueUpdate",
      (v) => {
        updates.push(v);
        return { issueUpdate: { success: true } };
      },
    ],
  ]);
  try {
    const lines = await captureLogs(() => runForwardSyncLinear({}, management));
    const actions = actionsFrom(lines);

    assert.equal(created.length, 1);
    assert.equal(created[0].teamId, "team-1");
    assert.deepEqual(created[0].labelIds, ["lb-backend", "lb-frontend"]);
    assert.match(created[0].description, /CARD_ID: PROJ-S1/);

    assert.deepEqual(
      actions.map((a) => `${a.action}:${a.cardId || a.child}`),
      ["UPDATED:PROJ-F1", "STATUS_SET:PROJ-F1", "CREATED:PROJ-S1", "STATUS_SET:PROJ-S1", "LINKED:lin-S1"]
    );
    assert.equal(actions[1].linearState, "In Progress", "statusMap maps In progress → In Progress");
    assert.ok(updates.some((u) => u.id === "lin-S1" && u.input.parentId === "lin-F1"));
    assert.equal(api.calls.filter((c) => c.body.query.includes("issueLabelCreate")).length, 1, "label created once, then cached");
    assert.ok(lines.some((l) => l.includes("=== LINEAR SYNC COMPLETE ===")));
  } finally {
    api.restore();
  }
});

test("forward keeps going when a label can't be created, a status has no match, or linking fails", async () => {
  resetCards({
    "features/PROJ-F2.md": cardMarkdown({ id: "PROJ-F2", type: "Feature", status: "Blocked by legal" }),
    "stories/PROJ-S2.md": cardMarkdown({ id: "PROJ-S2", parent: "PROJ-F2", categories: ["Infra"] }),
  });
  let n = 0;
  const api = linearApi([
    ["labels(first: 200)", () => ({ team: { labels: { nodes: [] } } })],
    ["issueLabelCreate", () => jsonResponse({ errors: [{ message: "label limit" }] })],
    ["containsIgnoreCase: $marker", () => ({ team: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } })],
    ["states {", () => ({ team: { states: { nodes: [{ id: "st-1", name: "Todo" }, { id: "st-2", name: "Backlog items" }] } } })],
    ["issueCreate", () => ({ issueCreate: { issue: { id: `lin-${++n}` } } })],
    ["issueUpdate", (v) => (v.input.parentId ? jsonResponse({ errors: [{ message: "cycle" }] }) : { issueUpdate: { success: true } })],
  ]);
  try {
    const lines = await captureLogs(() => runForwardSyncLinear({}, { ...management, statusMap: {} }));
    const actions = actionsFrom(lines);
    assert.ok(lines.some((l) => /WARN: could not create Linear label "Infra"/.test(l)));
    const skipped = actions.find((a) => a.action === "STATUS_SKIPPED");
    assert.equal(skipped.reason, "no_matching_state");
    assert.equal(skipped.hyperionStatus, "Blocked by legal");
    assert.ok(actions.some((a) => a.action === "STATUS_SET" && a.linearState === "Backlog items"), "Backlog falls back to a partial match");
    const linkFailed = actions.find((a) => a.action === "LINK_FAILED");
    assert.match(linkFailed.reason, /cycle/);
  } finally {
    api.restore();
  }
});

test("forward reports a GraphQL error instead of continuing silently", async () => {
  resetCards({ "stories/PROJ-S3.md": cardMarkdown({ id: "PROJ-S3" }) });
  const api = mockFetch(() => jsonResponse({ errors: [{ message: "Authentication required" }] }, 401));
  try {
    await assert.rejects(captureLogs(() => runForwardSyncLinear({}, management)), /Linear GraphQL failed:[\s\S]*Authentication required/);
  } finally {
    api.restore();
  }
});

test("forward says what to do when there are no cards, or only kit samples", async () => {
  resetCards({});
  const api = mockFetch(() => undefined);
  try {
    assert.ok((await captureLogs(() => runForwardSyncLinear({}, management))).some((l) => l.includes("No valid cards found for Linear mode.")));
    resetCards({ "stories/EXAMPLE-STORY-9.md": cardMarkdown({ id: "EXAMPLE-STORY-9" }) });
    const lines = await captureLogs(() => runForwardSyncLinear({}, management));
    assert.ok(lines.some((l) => l.includes("No cards to sync.")));
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("reverse patches local cards, recreates missing ones, skips samples and paginates", async () => {
  const local = cardMarkdown({ id: "PROJ-S4", status: "Backlog" });
  const missing = cardMarkdown({ id: "PROJ-S5", title: "Recreated from board" });
  const sample = cardMarkdown({ id: "EXAMPLE-STORY-1" });
  resetCards({ "stories/PROJ-S4.md": local });

  const pages = [
    {
      nodes: [
        { id: "i4", title: "Card PROJ-S4", description: remoteDescription("stories/PROJ-S4.md", local), state: { name: "In Progress" }, updatedAt: "2026-01-02T03:04:05Z", labels: { nodes: [] } },
        { id: "ix", title: "No marker", description: "plain text", state: null, labels: { nodes: [] } },
      ],
      pageInfo: { hasNextPage: true, endCursor: "p2" },
    },
    {
      nodes: [
        { id: "i5", title: "Recreated from board", description: remoteDescription("stories/PROJ-S5.md", missing), state: { name: "Done" }, labels: { nodes: [{ name: "Backend" }] } },
        { id: "is", title: "Sample", description: remoteDescription("stories/EXAMPLE-STORY-1.md", sample), state: { name: "Done" }, labels: { nodes: [] } },
      ],
      pageInfo: { hasNextPage: false },
    },
  ];
  const api = linearApi([["containsIgnoreCase: \"CARD_ID:\"", (v) => ({ team: { issues: v.after ? pages[1] : pages[0] } })]]);
  try {
    const lines = await captureLogs(() => runReverseSyncLinear({}, management));
    assert.ok(lines.some((l) => l.includes("Linear issues found: 3")));
    assert.match(ws.read(".github/cards/stories/PROJ-S4.md"), /status: "?In progress"?/);
    assert.match(ws.read(".github/cards/stories/PROJ-S4.md"), /board_sync_at: "?2026-01-02T03:04:05.000Z"?/);
    assert.ok(ws.exists(".github/cards/stories/PROJ-S5.md"), "card missing locally is recreated from the board");
    assert.match(ws.read(".github/cards/stories/PROJ-S5.md"), /status: "?Done"?/);
    assert.ok(lines.some((l) => l.includes("Skipped 1 kit sample issue(s).")));
    assert.ok(lines.some((l) => l.includes("Linear reverse sync wrote: 2 file(s)")));

    const again = await captureLogs(() => runReverseSyncLinear({}, management));
    assert.ok(again.some((l) => l.includes("Unchanged: 2 card(s).")));
  } finally {
    api.restore();
  }
});

test("reverse surfaces the API error", async () => {
  const api = mockFetch(() => jsonResponse({ message: "Bad gateway" }, 502));
  try {
    await assert.rejects(captureLogs(() => runReverseSyncLinear({}, management)), /Linear GraphQL failed:[\s\S]*Bad gateway/);
  } finally {
    api.restore();
  }
});

test("reverse with no matching issues says so", async () => {
  const api = linearApi([["containsIgnoreCase", () => ({ team: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } })]]);
  try {
    const lines = await captureLogs(() => runReverseSyncLinear({}, management));
    assert.ok(lines.some((l) => l.includes("No Linear issues with CARD_ID found.")));
  } finally {
    api.restore();
  }
});
