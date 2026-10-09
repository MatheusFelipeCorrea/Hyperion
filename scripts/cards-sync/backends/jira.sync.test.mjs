import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { cardMarkdown, captureLogs, jsonResponse, mockFetch, setupWorkspace } from "./sync-fixture.mjs";

const ws = setupWorkspace();
const { jiraIssueToCardMarkdown, runForwardSyncJira, runReverseSyncJira } = await import("./jira.mjs");
const { buildRemoteDescriptionFromCard, parseCardFile } = await import("../lib.mjs");

const management = {
  jiraUrl: "https://acme.atlassian.net//",
  jiraProjectKey: "PROJ",
  jiraEmail: "bot@acme.io",
  jiraApiToken: "jira-token",
  statusMap: { "In progress": "In Progress" },
};
const expectedAuth = `Basic ${Buffer.from("bot@acme.io:jira-token").toString("base64")}`;

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

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

/** REST router: `route(req)` additionally gets `req.path` and `req.params` (URLSearchParams). */
function jiraApi(route) {
  return mockFetch((req) => {
    const url = new URL(req.url);
    assert.equal(url.origin, "https://acme.atlassian.net");
    assert.equal(req.headers.Authorization, expectedAuth);
    assert.equal(req.headers.Accept, "application/json");
    return route({ ...req, path: url.pathname, params: url.searchParams });
  });
}

test.after(() => ws.cleanup());

test("forward and reverse refuse to run without url, project key, email and token", async () => {
  const msg = /JIRA_URL, JIRA_PROJECT_KEY, JIRA_EMAIL, and JIRA_API_TOKEN/;
  await assert.rejects(runForwardSyncJira({}, {}), msg);
  await assert.rejects(runForwardSyncJira({}, { ...management, jiraApiToken: "" }), msg);
  await assert.rejects(runReverseSyncJira({}, { ...management, jiraProjectKey: undefined }), msg);
  await assert.rejects(runReverseSyncJira({}, { ...management, jiraEmail: "" }), msg);
});

test("forward updates existing issues, creates new ones, transitions status and links parent/child", async () => {
  const feature = cardMarkdown({ id: "PROJ-F1", type: "Feature", status: "In progress" });
  const story = cardMarkdown({ id: "PROJ-S1", parent: "PROJ-F1", status: "Done", categories: ["Backend", "Frontend"] });
  const lookalike = cardMarkdown({ id: "PROJ-F10", type: "Feature" });
  resetCards({ "features/PROJ-F1.md": feature, "stories/PROJ-F1/PROJ-S1.md": story });

  const transitions = [
    { id: "21", name: "Start progress", to: { name: "In Progress" } },
    { id: "31", name: "Finish", to: { name: "Shipped" } },
  ];
  const api = jiraApi((req) => {
    if (req.method === "GET" && req.path === "/rest/api/2/search/jql") {
      return {
        issues: [
          { key: "PROJ-9", fields: { description: remoteDescription("features/PROJ-F10.md", lookalike) } },
          { key: "PROJ-8" },
          { key: "PROJ-1", fields: { description: remoteDescription("features/PROJ-F1.md", feature) } },
        ],
      };
    }
    if (req.method === "PUT" && req.path === "/rest/api/2/issue/PROJ-1") return emptyResponse();
    if (req.method === "POST" && req.path === "/rest/api/2/issue") return jsonResponse({ id: "10002", key: "PROJ-2" }, 201);
    if (req.method === "GET" && /\/transitions$/.test(req.path)) return { transitions };
    if (req.method === "POST" && /\/transitions$/.test(req.path)) return emptyResponse();
    if (req.method === "POST" && req.path === "/rest/api/2/issueLink") return emptyResponse(201);
    return undefined;
  });
  try {
    const lines = await captureLogs(() =>
      runForwardSyncJira({}, { ...management, statusMap: { ...management.statusMap, Done: "Shipped" } })
    );
    const actions = actionsFrom(lines);

    const searches = api.calls.filter((c) => c.url.includes("/search"));
    assert.equal(searches.length, 1, "one search indexes every card");
    const searchParams = new URL(searches[0].url).searchParams;
    assert.equal(searchParams.get("jql"), 'project = "PROJ" AND description ~ "\\"CARD_ID:\\"" ORDER BY updated DESC');
    assert.equal(searchParams.get("maxResults"), "100");

    const put = api.calls.find((c) => c.method === "PUT");
    assert.equal(put.body.fields.summary, "[Feature] Card PROJ-F1");
    assert.match(put.body.fields.description, /CARD_ID: PROJ-F1\n/);
    assert.deepEqual(put.body.fields.labels, []);

    const creates = api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/rest/api/2/issue"));
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].body.fields.project, { key: "PROJ" });
    assert.deepEqual(creates[0].body.fields.issuetype, { name: "Task" }, "issue type defaults to Task");
    assert.equal(creates[0].body.fields.summary, "[Story] Card PROJ-S1");
    assert.deepEqual(creates[0].body.fields.labels, ["Backend", "Frontend"]);
    assert.match(creates[0].body.fields.description, /SOURCE_FILE: \.github\/cards\/stories\/PROJ-F1\/PROJ-S1\.md/);

    const applied = api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/transitions"));
    assert.deepEqual(
      applied.map((c) => [new URL(c.url).pathname, c.body.transition.id]),
      [
        ["/rest/api/2/issue/PROJ-1/transitions", "21"],
        ["/rest/api/2/issue/PROJ-2/transitions", "31"],
      ]
    );

    const link = api.calls.find((c) => c.url.endsWith("/issueLink"));
    assert.deepEqual(link.body, { type: { name: "Relates" }, inwardIssue: { key: "PROJ-1" }, outwardIssue: { key: "PROJ-2" } });

    assert.deepEqual(
      actions.map((a) => `${a.action}:${a.cardId || `${a.parent}->${a.child}`}`),
      ["UPDATED:PROJ-F1", "STATUS_TRANSITIONED:PROJ-F1", "CREATED:PROJ-S1", "STATUS_TRANSITIONED:PROJ-S1", "LINKED:PROJ-1->PROJ-2"]
    );
    assert.equal(actions[1].transition, "Start progress");
    assert.equal(actions[1].to, "In Progress");
    assert.equal(actions[3].to, "Shipped", "statusMap maps Done → Shipped before picking the transition");
    assert.equal(actions[2].issueKey, "PROJ-2");
    assert.ok(lines.some((l) => l.includes("Valid cards: 2")));
    assert.ok(lines.some((l) => l.includes("Parent-child links: 1")));
    assert.ok(lines.some((l) => l.includes("=== JIRA SYNC COMPLETE ===")));
  } finally {
    api.restore();
  }
});

test("forward keeps going when no transition matches, a card has no status, linking fails or create returns no key", async () => {
  resetCards({
    "features/PROJ-F2.md": cardMarkdown({ id: "PROJ-F2", type: "Feature", status: "Blocked by legal" }),
    "stories/PROJ-S2.md": cardMarkdown({ id: "PROJ-S2", parent: "PROJ-F2", status: null }),
    "stories/PROJ-S3.md": cardMarkdown({ id: "PROJ-S3", parent: "PROJ-F2", status: "Done" }),
    "stories/notes.md": "# Just notes\n\nNo frontmatter here.\n",
  });
  const keys = { "PROJ-F2": "PROJ-20", "PROJ-S2": "PROJ-21" };
  const api = jiraApi((req) => {
    if (req.path === "/rest/api/2/search/jql") return { issues: [] };
    if (req.method === "POST" && req.path === "/rest/api/2/issue") {
      const key = keys[/CARD_ID: (\S+)/.exec(req.body.fields.description)[1]];
      return key ? { key } : {};
    }
    if (req.method === "GET" && req.path === "/rest/api/2/issue/PROJ-20/transitions") {
      return { transitions: [{ id: "1", to: { name: "In Progress" } }, { id: "2", name: "To Do" }, { id: "3" }] };
    }
    if (req.path === "/rest/api/2/issueLink") {
      return jsonResponse({ errorMessages: ["No issue link type with name 'Relates' found."] }, 400);
    }
    return undefined;
  });
  try {
    const lines = await captureLogs(() => runForwardSyncJira({}, { ...management, jiraIssueType: "Story" }));
    const actions = actionsFrom(lines);

    assert.ok(lines.some((l) => l.includes("SKIP (no frontmatter/card_id): .github/cards/stories/notes.md")));
    assert.ok(api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issue")).every((c) => c.body.fields.issuetype.name === "Story"));

    const skipped = actions.find((a) => a.action === "STATUS_SKIPPED");
    assert.equal(skipped.cardId, "PROJ-F2");
    assert.equal(skipped.reason, "no_matching_transition");
    assert.equal(skipped.targetStatus, "Blocked by legal");
    assert.deepEqual(skipped.available, ["In Progress", "To Do"]);
    assert.equal(api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/transitions")).length, 0);
    assert.equal(actions.filter((a) => a.cardId === "PROJ-S2" || a.cardId === "PROJ-S3").length, 2, "no status, or no issue key, only gets CREATED");
    assert.deepEqual(actions.find((a) => a.cardId === "PROJ-S3"), { action: "CREATED", cardId: "PROJ-S3", issueKey: null });
    assert.ok(!api.calls.some((c) => c.url.includes("undefined")), "no request for an issue without a key");

    const linkFailed = actions.find((a) => a.action === "LINK_FAILED");
    assert.equal(linkFailed.parent, "PROJ-20");
    assert.equal(linkFailed.child, "PROJ-21");
    assert.match(linkFailed.reason, /Jira request failed \(400[^)]*\): .*No issue link type/);
    assert.equal(api.calls.filter((c) => c.url.endsWith("/issueLink")).length, 1, "edge to a card without an issue key is not linked");
    assert.ok(lines.some((l) => l.includes("=== JIRA SYNC COMPLETE ===")));
  } finally {
    api.restore();
  }
});

test("forward surfaces Jira errors with status and payload, including non-JSON bodies", async () => {
  resetCards({ "stories/PROJ-S4.md": cardMarkdown({ id: "PROJ-S4" }) });
  let api = mockFetch(() => new Response(JSON.stringify({ errorMessages: ["Unauthorized"] }), { status: 401, statusText: "Unauthorized" }));
  try {
    await assert.rejects(
      captureLogs(() => runForwardSyncJira({}, management)),
      /Jira request failed \(401 Unauthorized\): \{"errorMessages":\["Unauthorized"\]\}/
    );
  } finally {
    api.restore();
  }

  api = mockFetch((req) =>
    req.method === "GET" ? { issues: [] } : new Response("<html>Service Unavailable</html>", { status: 503, statusText: "Service Unavailable" })
  );
  try {
    await assert.rejects(
      captureLogs(() => runForwardSyncJira({}, management)),
      /Jira request failed \(503 Service Unavailable\): \{"raw":"<html>Service Unavailable<\/html>"\}/
    );
  } finally {
    api.restore();
  }
});

test("forward says what to do when there are no cards, no valid cards, or only kit samples", async () => {
  const api = mockFetch(() => undefined);
  try {
    resetCards({});
    assert.ok((await captureLogs(() => runForwardSyncJira({}, management))).some((l) => l.includes("No card files found in")));

    resetCards({ "stories/notes.md": "just text\n" });
    const invalid = await captureLogs(() => runForwardSyncJira({}, management));
    assert.ok(invalid.some((l) => l.includes("No valid cards found (all files missing YAML frontmatter with card_id).")));

    resetCards({ "stories/EXAMPLE-STORY-9.md": cardMarkdown({ id: "EXAMPLE-STORY-9" }) });
    const samples = await captureLogs(() => runForwardSyncJira({}, management));
    assert.ok(samples.some((l) => l.includes("No cards to sync.")));
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("reverse patches local cards, recreates missing ones, skips samples/unmarked/unresolvable issues and paginates", async () => {
  const local = cardMarkdown({ id: "PROJ-S5", status: "Backlog" });
  const missing = cardMarkdown({ id: "PROJ-S6", title: "Recreated from board", status: "Done" });
  const sample = cardMarkdown({ id: "EXAMPLE-STORY-1" });
  resetCards({ "stories/PROJ-S5.md": local });

  const noCardId = [
    "Orphan body",
    "",
    "---",
    "<!-- SYNC_METADATA — do not edit below this line -->",
    "SOURCE_FILE: .github/cards/stories/PROJ-GONE.md",
    "<!-- /SYNC_METADATA -->",
  ].join("\n");
  const pages = {
    first: {
      nextPageToken: "page-2",
      issues: [
        {
          key: "PROJ-5",
          fields: {
            summary: "[Story] Card PROJ-S5",
            description: remoteDescription("stories/PROJ-S5.md", local),
            labels: [],
            status: { name: "In Progress" },
            updated: "2026-03-04T05:06:07.000+0000",
          },
        },
        { key: "PROJ-7", fields: { summary: "No marker", description: "plain text", status: { name: "Done" } } },
      ],
    },
    "page-2": {
      isLast: true,
      issues: [
        { key: "PROJ-6", fields: { summary: "[Story] Recreated from board", description: remoteDescription("stories/PROJ-S6.md", missing), labels: ["Backend"], status: null } },
        { key: "PROJ-90", fields: { summary: "Sample", description: remoteDescription("stories/EXAMPLE-STORY-1.md", sample), status: { name: "Done" } } },
        { key: "PROJ-91", fields: { summary: "Orphan", description: noCardId } },
      ],
    },
  };
  const api = jiraApi((req) => {
    if (req.method !== "GET" || req.path !== "/rest/api/2/search/jql") return undefined;
    assert.equal(req.params.get("jql"), 'project = "PROJ" AND description ~ "\\"CARD_ID:\\"" ORDER BY updated DESC');
    assert.equal(req.params.get("maxResults"), "100");
    assert.equal(req.params.get("fields"), "summary,description,labels,status,updated");
    return pages[req.params.get("nextPageToken") || "first"];
  });
  try {
    const lines = await captureLogs(() => runReverseSyncJira({}, management));
    assert.deepEqual(
      api.calls.map((c) => new URL(c.url).searchParams.get("nextPageToken")),
      [null, "page-2"]
    );
    assert.match(ws.read(".github/cards/stories/PROJ-S5.md"), /board_sync_at: "?2026-03-04T05:06:07.000Z"?/);
    assert.ok(lines.some((l) => l.includes("Backend: jira")));
    assert.ok(lines.some((l) => l.includes("Direction: reverse (Jira -> Markdown)")));
    assert.ok(lines.some((l) => l.includes("Jira issues found: 5")));

    assert.match(ws.read(".github/cards/stories/PROJ-S5.md"), /status: "?In progress"?/, "statusMap maps In Progress back to In progress");
    assert.ok(lines.some((l) => l.includes("Patched: .github/cards/stories/PROJ-S5.md (Jira PROJ-5)")));

    const recreated = ws.read(".github/cards/stories/PROJ-S6.md");
    assert.match(recreated, /status: "?Done"?/, "no remote status keeps STATUS from the metadata");
    assert.match(recreated, /title: "?Recreated from board"?/);
    assert.match(recreated, /- "?Backend"?/);
    assert.ok(lines.some((l) => l.includes("Created: .github/cards/stories/PROJ-S6.md (Jira PROJ-6)")));

    assert.ok(!ws.exists(".github/cards/stories/EXAMPLE-STORY-1.md"));
    assert.ok(!ws.exists(".github/cards/stories/PROJ-GONE.md"));
    assert.ok(lines.some((l) => l.includes("SKIP (no local card, invalid metadata): .github/cards/stories/PROJ-GONE.md (Jira PROJ-91)")));
    assert.ok(lines.some((l) => l.includes("Skipped 1 kit sample issue(s).")));
    assert.ok(lines.some((l) => l.includes("Jira reverse sync wrote: 2 file(s)")));
    assert.ok(lines.some((l) => l.includes("Skipped: 1 issue(s).")));
    assert.ok(!lines.some((l) => l.includes("Unchanged:")));

    const again = await captureLogs(() => runReverseSyncJira({}, management));
    assert.ok(again.some((l) => l.includes("Unchanged: 2 card(s).")));
    assert.ok(again.some((l) => l.includes("Jira reverse sync wrote: 0 file(s)")));
  } finally {
    api.restore();
  }
});

test("forward finds an existing issue past the first page instead of creating a duplicate", async () => {
  const story = cardMarkdown({ id: "PROJ-S8" });
  resetCards({ "stories/PROJ-S8.md": story });
  const filler = Array.from({ length: 100 }, (_, i) => ({ key: `PROJ-${1000 + i}`, fields: { description: "plain text" } }));
  const api = jiraApi((req) => {
    if (req.path === "/rest/api/2/search/jql") {
      return req.params.get("nextPageToken")
        ? { isLast: true, issues: [{ key: "PROJ-8", fields: { description: remoteDescription("stories/PROJ-S8.md", story) } }] }
        : { nextPageToken: "next", issues: filler };
    }
    if (req.method === "PUT" && req.path === "/rest/api/2/issue/PROJ-8") return emptyResponse();
    if (/\/transitions$/.test(req.path)) return { transitions: [{ id: "1", to: { name: "Backlog" } }] };
  });
  try {
    const actions = actionsFrom(await captureLogs(() => runForwardSyncJira({}, management)));
    assert.equal(actions[0].action, "UPDATED");
    assert.equal(actions[0].issueKey, "PROJ-8");
    assert.ok(!api.calls.some((c) => c.method === "POST" && c.url.endsWith("/rest/api/2/issue")));
  } finally {
    api.restore();
  }
});

test("Jira Data Center without /search/jql falls back to /search paged by startAt", async () => {
  resetCards({});
  const pages = {
    0: { startAt: 0, total: 3, issues: [{ key: "PROJ-1" }, { key: "PROJ-2" }] },
    2: { startAt: 2, total: 3, issues: [{ key: "PROJ-3" }] },
  };
  const api = jiraApi((req) => {
    if (req.path === "/rest/api/2/search/jql") return jsonResponse({ errorMessages: ["Not found"] }, 404);
    if (req.path === "/rest/api/2/search") return pages[req.params.get("startAt")];
  });
  try {
    const lines = await captureLogs(() => runReverseSyncJira({}, management));
    assert.ok(lines.some((l) => l.includes("Jira issues found: 3")));
    assert.deepEqual(
      api.calls.filter((c) => new URL(c.url).pathname === "/rest/api/2/search").map((c) => new URL(c.url).searchParams.get("startAt")),
      ["0", "2"]
    );
  } finally {
    api.restore();
  }
});

test("a 405 from /search/jql also falls back to /search, and an error names both endpoints when both fail", async () => {
  resetCards({});
  let api = jiraApi((req) => {
    if (req.path === "/rest/api/2/search/jql") return jsonResponse({ errorMessages: ["Method Not Allowed"] }, 405);
    if (req.path === "/rest/api/2/search") return { startAt: 0, total: 1, issues: [{ key: "PROJ-1" }] };
  });
  try {
    const lines = await captureLogs(() => runReverseSyncJira({}, management));
    assert.ok(lines.some((l) => l.includes("Jira issues found: 1")));
  } finally {
    api.restore();
  }

  api = jiraApi((req) => {
    if (req.path === "/rest/api/2/search/jql") return jsonResponse({ errorMessages: ["Not found"] }, 404);
    if (req.path === "/rest/api/2/search") return jsonResponse({ errorMessages: ["Gone"] }, 410);
  });
  try {
    await assert.rejects(captureLogs(() => runReverseSyncJira({}, management)), (error) => {
      assert.match(error.message, /\/rest\/api\/2\/search\/jql \(Jira request failed \(404[^)]*\): .*Not found.*\)/);
      assert.match(error.message, /\/rest\/api\/2\/search fallback \(Jira request failed \(410[^)]*\): .*Gone.*\)/);
      assert.equal(error.status, 410);
      return true;
    });
  } finally {
    api.restore();
  }
});

test("forward falls back to the card's own status, and skips the transition when the issue is already there", async () => {
  const cards = {
    "stories/PROJ-S1.md": cardMarkdown({ id: "PROJ-S1", status: "Done" }),
    "stories/PROJ-S2.md": cardMarkdown({ id: "PROJ-S2", status: "In progress" }),
    "stories/PROJ-S3.md": cardMarkdown({ id: "PROJ-S3", status: "Done" }),
  };
  resetCards(cards);
  const issue = (key, n, status) => ({
    key,
    fields: { description: remoteDescription(`stories/PROJ-S${n}.md`, cards[`stories/PROJ-S${n}.md`]), status: { name: status } },
  });
  const api = jiraApi((req) => {
    if (req.path === "/rest/api/2/search/jql") {
      assert.equal(req.params.get("fields"), "summary,labels,description,status");
      return { issues: [issue("PROJ-1", 1, "To Do"), issue("PROJ-2", 2, "In Progress"), issue("PROJ-3", 3, "Done")] };
    }
    if (req.method === "PUT") return emptyResponse();
    if (req.method === "GET" && /\/transitions$/.test(req.path)) {
      return { transitions: [{ id: "41", name: "Close", to: { name: "Done" } }] };
    }
    if (req.method === "POST" && req.path === "/rest/api/2/issue/PROJ-1/transitions") return emptyResponse();
  });
  try {
    const lines = await captureLogs(() =>
      runForwardSyncJira({}, { ...management, statusMap: { ...management.statusMap, Done: "Shipped" } })
    );
    const statuses = actionsFrom(lines).filter((a) => a.action.startsWith("STATUS"));
    assert.deepEqual(
      statuses.map((a) => `${a.action}:${a.issueKey}`),
      ["STATUS_TRANSITIONED:PROJ-1", "STATUS_UNCHANGED:PROJ-2", "STATUS_UNCHANGED:PROJ-3"]
    );
    assert.equal(statuses[0].to, "Done", "no transition to Shipped, so the card's own status Done is used");
    assert.equal(statuses[1].reason, "already_in_status");
    assert.equal(statuses[1].current, "In Progress");
    assert.equal(statuses[2].targetStatus, "Shipped");
    assert.equal(statuses[2].current, "Done", "already in the fallback status and Shipped is not reachable");
    assert.deepEqual(
      api.calls.filter((c) => c.url.endsWith("/transitions")).map((c) => `${c.method} ${new URL(c.url).pathname}`),
      ["GET /rest/api/2/issue/PROJ-1/transitions", "POST /rest/api/2/issue/PROJ-1/transitions", "GET /rest/api/2/issue/PROJ-3/transitions"],
      "PROJ-2 is already in the mapped status, so its transitions are not even read"
    );
  } finally {
    api.restore();
  }
});

test("forward updates the canonical issue when several carry the same CARD_ID: open first, then the lowest number", async () => {
  const story = cardMarkdown({ id: "PROJ-S9", status: null });
  resetCards({ "stories/PROJ-S9.md": story });
  const description = remoteDescription("stories/PROJ-S9.md", story);
  const api = jiraApi((req) => {
    if (req.path === "/rest/api/2/search/jql") {
      return {
        issues: [
          { key: "PROJ-12", fields: { description, status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } },
          { key: "PROJ-3", fields: { description, status: { name: "Done", statusCategory: { key: "done" } } } },
          { key: "PROJ-7", fields: { description, status: { name: "To Do", statusCategory: { key: "new" } } } },
        ],
      };
    }
    if (req.method === "PUT" && req.path === "/rest/api/2/issue/PROJ-7") return emptyResponse();
  });
  try {
    const actions = actionsFrom(await captureLogs(() => runForwardSyncJira({}, management)));
    assert.deepEqual(actions, [{ action: "UPDATED", cardId: "PROJ-S9", issueKey: "PROJ-7" }]);
  } finally {
    api.restore();
  }
});

test("a 404 from /search/jql after the first page is an error, not a fallback", async () => {
  const api = jiraApi((req) =>
    req.params.get("nextPageToken") ? jsonResponse({ errorMessages: ["expired"] }, 404) : { nextPageToken: "t", issues: [{ key: "PROJ-1" }] }
  );
  try {
    await assert.rejects(captureLogs(() => runReverseSyncJira({}, management)), /Jira request failed \(404/);
  } finally {
    api.restore();
  }
});

test("reverse surfaces the API error", async () => {
  const api = mockFetch(() => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
  try {
    await assert.rejects(
      captureLogs(() => runReverseSyncJira({}, management)),
      /Jira request failed \(502 Bad Gateway\): \{"raw":"<html>bad gateway<\/html>"\}/
    );
  } finally {
    api.restore();
  }
});

test("jiraIssueToCardMarkdown round-trips a forward-synced issue and ignores issues without metadata", () => {
  const content = cardMarkdown({ id: "PROJ-E1", type: "Epic", title: "Login flow", status: "In progress", categories: ["Backend"] });
  const converted = jiraIssueToCardMarkdown({
    fields: { summary: "[Epic] Login flow", description: remoteDescription("epics/PROJ-E1.md", content), labels: ["Auth"] },
  });
  assert.equal(converted.sourceFile, ".github/cards/epics/PROJ-E1.md");
  assert.match(converted.markdown, /card_id: "PROJ-E1"/);
  assert.match(converted.markdown, /status: "In progress"/);
  assert.match(converted.markdown, /- "?Auth"?/, "Jira labels win over CATEGORIES metadata");

  assert.equal(jiraIssueToCardMarkdown({ fields: { summary: "x", description: "plain text" } }), null);
  assert.equal(jiraIssueToCardMarkdown(undefined), null);
});

test("reverse with no matching issues says so", async () => {
  const api = jiraApi(() => ({}));
  try {
    const lines = await captureLogs(() => runReverseSyncJira({}, { ...management, statusMap: undefined }));
    assert.ok(lines.some((l) => l.includes("No Jira issues with CARD_ID found.")));
    assert.equal(api.calls.length, 1);
  } finally {
    api.restore();
  }
});
