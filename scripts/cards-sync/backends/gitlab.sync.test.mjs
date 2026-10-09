import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { cardMarkdown, captureLogs, jsonResponse, mockFetch, setupWorkspace } from "./sync-fixture.mjs";

const ws = setupWorkspace();
const { runForwardSyncGitLab, runReverseSyncGitLab, resolveGitLabStatusAction, gitlabListCardIssues, gitlabIssueLabels, GITLAB_MAX_PAGES } =
  await import("./gitlab.mjs");
const { buildRemoteDescriptionFromCard, parseCardFile } = await import("../lib.mjs");

const management = {
  gitlabProjectId: "acme/app",
  gitlabToken: "gl-token",
  gitlabUrl: "https://gitlab.acme.dev/",
  statusMap: { "In Progress": "Doing" },
};
const issuesPath = "/api/v4/projects/acme%2Fapp/issues";

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

/** REST router: handler gets the request plus `path` (still URL-encoded) and `query` (URLSearchParams). */
function gitlabApi(handler, { host = "gitlab.acme.dev" } = {}) {
  return mockFetch((req) => {
    const url = new URL(req.url);
    assert.equal(url.host, host);
    assert.equal(req.headers["PRIVATE-TOKEN"], "gl-token");
    return handler({ ...req, path: url.pathname, query: url.searchParams });
  });
}

function textResponse(text, status, statusText = "") {
  return new Response(text, { status, statusText });
}

test.after(() => ws.cleanup());

test("resolveGitLabStatusAction closes on Done-like statuses and reopens + labels everything else", () => {
  assert.equal(resolveGitLabStatusAction({}, null), null);
  assert.deepEqual(resolveGitLabStatusAction({}, "Done"), { state_event: "close", label: "Done", mapped: "Done" });
  assert.deepEqual(resolveGitLabStatusAction({ Done: "Concluído" }, "Done"), {
    state_event: "close",
    label: "Concluído",
    mapped: "Concluído",
  });
  assert.equal(resolveGitLabStatusAction({}, "Resolved").state_event, "close");
  assert.deepEqual(resolveGitLabStatusAction({ "In Progress": "Doing" }, "In Progress"), {
    state_event: "reopen",
    label: "Doing",
    mapped: "Doing",
  });
});

test("forward and reverse refuse to run without project id and token", async () => {
  await assert.rejects(runForwardSyncGitLab({}, {}), /GITLAB_PROJECT_ID and GITLAB_TOKEN/);
  await assert.rejects(runForwardSyncGitLab({}, { gitlabProjectId: "1" }), /GITLAB_PROJECT_ID and GITLAB_TOKEN/);
  await assert.rejects(runReverseSyncGitLab({}, { gitlabToken: "t" }), /GITLAB_PROJECT_ID and GITLAB_TOKEN/);
});

test("forward updates existing issues, creates new ones, applies status label/state and links child to parent", async () => {
  const feature = cardMarkdown({ id: "PROJ-F1", type: "Feature", status: "In Progress" });
  const story = cardMarkdown({ id: "PROJ-S1", parent: "PROJ-F1", status: "Done", categories: ["Backend"] });
  // A child whose PARENT_CARD_ID is PROJ-F1 must not be taken for PROJ-F1's issue.
  const decoy = remoteDescription("stories/PROJ-S9.md", cardMarkdown({ id: "PROJ-S9", parent: "PROJ-F1" }));
  resetCards({ "features/PROJ-F1.md": feature, "stories/PROJ-F1/PROJ-S1.md": story });

  const api = gitlabApi((req) => {
    if (req.method === "GET" && req.path === issuesPath) {
      assert.equal(req.query.get("state"), "all");
      assert.equal(req.query.get("per_page"), "100");
      assert.equal(req.query.get("search"), "CARD_ID:");
      return [
        { iid: 99, description: decoy },
        { iid: 11, description: remoteDescription("features/PROJ-F1.md", feature) },
      ];
    }
    if (req.method === "POST" && req.path === issuesPath) return jsonResponse({ iid: 12 }, 201);
    if (req.method === "PUT" && /\/issues\/(11|12)$/.test(req.path)) return {};
    if (req.method === "POST" && req.path === `${issuesPath}/12/links`) return jsonResponse({}, 201);
    return undefined;
  });
  try {
    const lines = await captureLogs(() => runForwardSyncGitLab({}, management));
    const actions = actionsFrom(lines);

    assert.deepEqual(
      actions.map((a) => `${a.action}:${a.cardId || a.child}`),
      ["UPDATED:PROJ-F1", "STATUS_SET:PROJ-F1", "CREATED:PROJ-S1", "STATUS_SET:PROJ-S1", "LINKED:12"]
    );
    assert.equal(actions[0].gitlabIssueIid, 11, "exact CARD_ID match wins over the PARENT_CARD_ID decoy");
    assert.equal(actions[1].gitlabStateEvent, "reopen");
    assert.equal(actions[1].mapped, "Doing", "statusMap maps In Progress → Doing");
    assert.equal(actions[3].gitlabStateEvent, "close");
    assert.deepEqual(actions[4], { action: "LINKED", parent: 11, child: 12 });
    assert.ok(lines.some((l) => l.includes("Parent-child links: 1")));
    assert.ok(lines.some((l) => l.includes("=== GITLAB SYNC COMPLETE ===")));

    assert.equal(api.calls.filter((c) => c.method === "GET").length, 1, "one search indexes every card");
    const writes = api.calls.filter((c) => c.method !== "GET");
    assert.deepEqual(
      writes.map((c) => `${c.method} ${new URL(c.url).pathname}`),
      [
        `PUT ${issuesPath}/11`,
        `PUT ${issuesPath}/11`,
        `POST ${issuesPath}`,
        `PUT ${issuesPath}/12`,
        `POST ${issuesPath}/12/links`,
      ]
    );
    assert.ok(writes.every((c) => c.url.startsWith("https://gitlab.acme.dev/api/v4/")), "trailing slash on gitlabUrl is stripped");
    assert.equal(writes[0].body.title, "[Feature] Card PROJ-F1");
    assert.deepEqual(writes[0].body.labels, ["status:Doing"], "the update keeps the status label");
    assert.match(writes[0].body.description, /CARD_ID: PROJ-F1/);
    assert.deepEqual(writes[1].body, { state_event: "reopen" });
    assert.equal(writes[2].body.title, "[Story] Card PROJ-S1");
    assert.deepEqual(writes[2].body.labels, ["Backend", "status:Done"]);
    assert.match(writes[2].body.description, /SOURCE_FILE: \.github\/cards\/stories\/PROJ-F1\/PROJ-S1\.md/);
    assert.deepEqual(writes[3].body, { state_event: "close" });
    assert.deepEqual(writes[4].body, { target_project_id: "acme/app", target_issue_iid: 11, link_type: "relates_to" });
    assert.equal(writes[0].headers["Content-Type"], "application/json");
  } finally {
    api.restore();
  }
});

test("forward keeps going when status update or linking fails, and when create returns no iid", async () => {
  resetCards({
    "features/PROJ-F2.md": cardMarkdown({ id: "PROJ-F2", type: "Feature", status: "Backlog" }),
    "stories/PROJ-S2.md": cardMarkdown({ id: "PROJ-S2", parent: "PROJ-F2", status: "Done", categories: ["status:Done"] }),
    "stories/PROJ-S3.md": cardMarkdown({ id: "PROJ-S3", parent: "PROJ-F2", status: "null" }),
    "stories/notes.md": "just some notes, no frontmatter\n",
  });
  const iidByTitle = { "[Feature] Card PROJ-F2": 21, "[Story] Card PROJ-S2": 22 };
  const api = gitlabApi((req) => {
    if (req.method === "GET") return [];
    if (req.method === "POST" && req.path === issuesPath) {
      const iid = iidByTitle[req.body.title];
      return jsonResponse(iid ? { iid } : {}, 201);
    }
    if (req.method === "PUT" && req.path === `${issuesPath}/21`) return textResponse("forbidden", 403, "Forbidden");
    if (req.method === "PUT" && req.path === `${issuesPath}/22`) return new Response(null, { status: 204 });
    if (req.method === "POST" && req.path === `${issuesPath}/22/links`) {
      return jsonResponse({ message: "Issue(s) already assigned" }, 409);
    }
    return undefined;
  });
  try {
    const lines = await captureLogs(() => runForwardSyncGitLab({}, { ...management, statusMap: undefined }));
    const actions = actionsFrom(lines);

    const skipped = actions.find((a) => a.action === "STATUS_SKIPPED");
    assert.equal(skipped.cardId, "PROJ-F2");
    assert.equal(skipped.mapped, "Backlog");
    assert.match(skipped.reason, /GitLab request failed \(403 Forbidden\): \{"raw":"forbidden"\}/);
    const creates = api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"));
    assert.deepEqual(creates[0].body.labels, ["status:Backlog"], "a failed state change still leaves the status label on the issue");

    const s2Status = actions.find((a) => a.action === "STATUS_SET" && a.cardId === "PROJ-S2");
    assert.equal(s2Status.gitlabStateEvent, "close", "empty 204 body is accepted");
    assert.deepEqual(creates[1].body.labels, ["status:Done"], "a status:* category gives way to the managed status label");

    assert.deepEqual(actions.find((a) => a.cardId === "PROJ-S3"), { action: "CREATED", cardId: "PROJ-S3", gitlabIssueIid: null });
    assert.ok(!actions.some((a) => a.cardId === "PROJ-S3" && a.action.startsWith("STATUS")), "no iid → no status call");

    const linkFailed = actions.filter((a) => a.action.startsWith("LINK"));
    assert.equal(linkFailed.length, 1, "PROJ-S3 has no iid, so its link is skipped");
    assert.equal(linkFailed[0].action, "LINK_FAILED");
    assert.equal(linkFailed[0].parent, 21);
    assert.equal(linkFailed[0].child, 22);
    assert.match(linkFailed[0].reason, /409.*already assigned/);
    assert.equal(api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/links")).length, 1);
  } finally {
    api.restore();
  }
});

test("forward finds an existing issue past the first page instead of creating a duplicate", async () => {
  const story = cardMarkdown({ id: "PROJ-S8", status: null });
  resetCards({ "stories/PROJ-S8.md": story });
  const filler = Array.from({ length: 100 }, (_, i) => ({
    iid: 1000 + i,
    description: remoteDescription(`stories/PROJ-X${i}.md`, cardMarkdown({ id: `PROJ-X${i}` })),
  }));
  const api = gitlabApi((req) => {
    if (req.method === "GET") {
      return req.query.get("page") === "1" ? filler : [{ iid: 8, description: remoteDescription("stories/PROJ-S8.md", story) }];
    }
    if (req.method === "PUT" && req.path === `${issuesPath}/8`) return {};
  });
  try {
    const actions = actionsFrom(await captureLogs(() => runForwardSyncGitLab({}, management)));
    assert.deepEqual(actions, [{ action: "UPDATED", cardId: "PROJ-S8", gitlabIssueIid: 8 }]);
    assert.ok(!api.calls.some((c) => c.method === "POST"));
  } finally {
    api.restore();
  }
});

test("forward surfaces the API error, using gitlab.com by default", async () => {
  resetCards({ "stories/PROJ-S3.md": cardMarkdown({ id: "PROJ-S3" }) });
  const api = gitlabApi(() => jsonResponse({ message: "401 Unauthorized" }, 401), { host: "gitlab.com" });
  try {
    await assert.rejects(
      captureLogs(() => runForwardSyncGitLab({}, { gitlabProjectId: 123, gitlabToken: "gl-token" })),
      /GitLab request failed \(401 \): \{"message":"401 Unauthorized"\}/
    );
    assert.equal(api.calls.length, 1);
    assert.ok(api.calls[0].url.startsWith("https://gitlab.com/api/v4/projects/123/issues?search="));
  } finally {
    api.restore();
  }
});

test("forward says what to do when there are no cards, or only kit samples", async () => {
  resetCards({});
  const api = mockFetch(() => undefined);
  try {
    assert.ok((await captureLogs(() => runForwardSyncGitLab({}, management))).some((l) => l.includes("No valid cards found for GitLab mode.")));
    resetCards({ "stories/EXAMPLE-STORY-9.md": cardMarkdown({ id: "EXAMPLE-STORY-9" }) });
    const lines = await captureLogs(() => runForwardSyncGitLab({}, management));
    assert.ok(lines.some((l) => l.includes("No cards to sync.")));
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("reverse patches local cards, recreates missing ones, skips samples/invalid ones and paginates", async () => {
  const s4 = cardMarkdown({ id: "PROJ-S4", status: "Backlog" });
  const s5 = cardMarkdown({ id: "PROJ-S5", title: "Recreated from board" });
  const s6 = cardMarkdown({ id: "PROJ-S6", status: "Backlog" });
  const s7 = cardMarkdown({ id: "PROJ-S7" });
  const sample = cardMarkdown({ id: "EXAMPLE-STORY-1" });
  resetCards({
    "stories/PROJ-S4.md": s4,
    "stories/PROJ-S6.md": s6,
    "stories/PROJ-S7.md": "corrupted: no frontmatter here\n",
  });

  const filler = Array.from({ length: 98 }, (_, i) => ({ iid: 1000 + i, title: `Unrelated ${i}`, description: "plain text", labels: [] }));
  const page1 = [
    {
      iid: 4,
      title: "[Story] Card PROJ-S4",
      description: remoteDescription("stories/PROJ-S4.md", s4),
      state: "opened",
      labels: ["status:Doing"],
      updated_at: "2026-01-02T03:04:05Z",
    },
    {
      iid: 8,
      title: "Hand-written marker",
      description: "<!-- SYNC_METADATA -->\nCARD_ID: PROJ-S8\n<!-- /SYNC_METADATA -->",
      state: "opened",
      labels: [],
    },
    ...filler,
  ];
  const page2 = [
    {
      iid: 5,
      title: "[Story] Recreated from board",
      description: remoteDescription("stories/PROJ-S5.md", s5),
      state: "closed",
      labels: ["Backend"],
    },
    { iid: 9, title: "Sample", description: remoteDescription("stories/EXAMPLE-STORY-1.md", sample), state: "closed", labels: [] },
    { iid: 6, title: "[Story] Card PROJ-S6", description: remoteDescription("stories/PROJ-S6.md", s6), state: "opened" },
    { iid: 7, title: "[Story] Card PROJ-S7", description: remoteDescription("stories/PROJ-S7.md", s7), state: "locked", labels: [] },
  ];
  const api = gitlabApi((req) => {
    assert.equal(req.method, "GET");
    assert.equal(req.path, issuesPath);
    assert.equal(req.query.get("search"), "CARD_ID:");
    assert.equal(req.query.get("per_page"), "100");
    return req.query.get("page") === "1" ? page1 : page2;
  });
  try {
    const lines = await captureLogs(() => runReverseSyncGitLab({}, management));
    assert.deepEqual(
      api.calls.map((c) => new URL(c.url).searchParams.get("page")),
      ["1", "2"],
      "a full page of 100 triggers the next page; a short page stops"
    );
    assert.equal(api.calls[0].headers.Accept, "application/json");
    assert.ok(lines.some((l) => l.endsWith("Backend: gitlab")));
    assert.ok(lines.some((l) => l.endsWith("Dry-run: no")));
    assert.ok(lines.some((l) => l.endsWith("Direction: reverse (GitLab -> Markdown)")));
    assert.ok(lines.some((l) => l.includes("GitLab issues found: 6")), "only issues carrying a CARD_ID are kept");

    const patched4 = ws.read(".github/cards/stories/PROJ-S4.md");
    assert.match(patched4, /status: "?In Progress"?/, "status:Doing label maps back through the inverse statusMap");
    assert.match(patched4, /board_sync_at: "?2026-01-02T03:04:05.000Z"?/);
    assert.ok(lines.some((l) => l.includes("Patched: .github/cards/stories/PROJ-S4.md (GitLab #4)")));

    assert.ok(ws.exists(".github/cards/stories/PROJ-S5.md"), "card missing locally is recreated from the board");
    const created5 = ws.read(".github/cards/stories/PROJ-S5.md");
    assert.match(created5, /status: "?Done"?/, "closed issue without status label → Done");
    assert.match(created5, /Backend/);

    assert.match(ws.read(".github/cards/stories/PROJ-S6.md"), /status: "?In Progress"?/i, "opened issue without status label → In Progress");
    assert.equal(ws.read(".github/cards/stories/PROJ-S7.md"), "corrupted: no frontmatter here\n");
    assert.ok(lines.some((l) => l.includes("SKIP (invalid frontmatter): .github/cards/stories/PROJ-S7.md (GitLab #7)")));
    assert.ok(!ws.exists(".github/cards/stories/PROJ-S8.md"), "issue without SOURCE_FILE is ignored");
    assert.ok(!ws.exists(".github/cards/stories/EXAMPLE-STORY-1.md"));

    assert.ok(lines.some((l) => l.includes("Skipped 1 kit sample issue(s).")));
    assert.ok(lines.some((l) => l.includes("GitLab reverse sync wrote: 3 file(s)")));
    assert.ok(lines.some((l) => l.includes("Skipped: 1 issue(s).")));

    const again = await captureLogs(() => runReverseSyncGitLab({}, management));
    assert.ok(again.some((l) => l.includes("Unchanged: 3 card(s).")));
    assert.ok(again.some((l) => l.includes("GitLab reverse sync wrote: 0 file(s)")));
  } finally {
    api.restore();
  }
});

test("reverse surfaces the API error, including non-JSON bodies", async () => {
  const api = gitlabApi(() => textResponse("<html>Bad gateway</html>", 502), { host: "gitlab.com" });
  try {
    await assert.rejects(
      captureLogs(() => runReverseSyncGitLab({}, { gitlabProjectId: 123, gitlabToken: "gl-token" })),
      /GitLab request failed \(502\): \{"raw":"<html>Bad gateway<\/html>"\}/
    );
    assert.ok(api.calls[0].url.startsWith("https://gitlab.com/api/v4/projects/123/issues?"));
  } finally {
    api.restore();
  }
});

test("reverse with no matching issues says so (empty list, non-array payload, or pages of noise)", async () => {
  for (const respond of [() => [], () => ({}), () => new Response("", { status: 200 })]) {
    const api = gitlabApi(respond);
    try {
      const lines = await captureLogs(() => runReverseSyncGitLab({}, management));
      assert.ok(lines.some((l) => l.includes("No GitLab issues with CARD_ID found.")));
      assert.equal(api.calls.length, 1);
    } finally {
      api.restore();
    }
  }

  const noise = Array.from({ length: 100 }, (_, i) => ({ iid: i, description: "no metadata" }));
  const api = gitlabApi((req) => (Number(req.query.get("page")) <= 12 ? noise : noise.slice(0, 3)));
  try {
    const lines = await captureLogs(() => runReverseSyncGitLab({}, management));
    assert.equal(api.calls.length, 13, "without an x-next-page header, paging continues until a short page");
    assert.ok(lines.some((l) => l.includes("No GitLab issues with CARD_ID found.")));
  } finally {
    api.restore();
  }
});

test("gitlabListCardIssues follows x-next-page, falls back to short pages without it, and stops at a page cap", async () => {
  const issue = (iid) => ({ iid, description: remoteDescription(`stories/PROJ-P${iid}.md`, cardMarkdown({ id: `PROJ-P${iid}` })) });
  const pageOf = (n) => (n === 100 ? Array.from({ length: 100 }, (_, i) => issue(i + 1)) : [issue(n)]);

  const requested = [];
  const nextPage = { 1: "3", 3: "" };
  const followed = await gitlabListCardIssues(async (endpoint) => {
    const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
    requested.push(page);
    return { payload: pageOf(page === 1 ? 1 : 100), headers: new Headers({ "x-next-page": nextPage[page] }) };
  }, "acme/app");
  assert.deepEqual(requested, [1, 3], "the header picks the next page, and an empty one ends the listing even after a full page");
  assert.equal(followed.length, 101);

  let calls = 0;
  await assert.rejects(
    gitlabListCardIssues(async () => {
      calls += 1;
      return { payload: pageOf(100), headers: new Headers({ "x-next-page": String(calls + 1) }) };
    }, "acme/app"),
    new RegExp(`stopped at the ${GITLAB_MAX_PAGES}-page safety cap \\(${GITLAB_MAX_PAGES * 100} issues`)
  );
  assert.equal(calls, GITLAB_MAX_PAGES);

  calls = 0;
  await assert.rejects(
    gitlabListCardIssues(
      async () => {
        calls += 1;
        return { payload: pageOf(100) };
      },
      "acme/app",
      { maxPages: 3 }
    ),
    /3-page safety cap/,
    "full pages without the header are capped too"
  );
  assert.equal(calls, 3);
});

test("gitlabIssueLabels keeps labels Hyperion doesn't manage and replaces the ones it does", () => {
  const card = parseCardFile(
    cardMarkdown({ id: "PROJ-L1", status: "In Progress", categories: ["Backend", "status:Review"] }),
    ".github/cards/stories/PROJ-L1.md"
  );
  const previous = parseCardFile(cardMarkdown({ id: "PROJ-L1", categories: ["Backend", "Legacy"] }), ".github/cards/stories/PROJ-L1.md");
  const existing = {
    description: buildRemoteDescriptionFromCard(previous),
    labels: ["needs-design", "backend", "Legacy", "status:Backlog", "Status:Old", "priority::high"],
  };

  assert.deepEqual(gitlabIssueLabels(card, management.statusMap, existing), ["needs-design", "priority::high", "Backend", "status:Doing"]);
  assert.deepEqual(gitlabIssueLabels(card, management.statusMap), ["Backend", "status:Doing"], "create: no existing labels");

  const noStatus = { ...card, status: null };
  assert.deepEqual(
    gitlabIssueLabels(noStatus, {}, existing),
    ["needs-design", "status:Backlog", "Status:Old", "priority::high", "Backend"],
    "a card without a status leaves the issue's status labels alone"
  );
});

test("forward update sends the issue's own labels back with the managed ones", async () => {
  const story = cardMarkdown({ id: "PROJ-S7", status: "Done", categories: ["Frontend"] });
  resetCards({ "stories/PROJ-S7.md": story });
  const api = gitlabApi((req) => {
    if (req.method === "GET") {
      return [{ iid: 7, state: "opened", description: remoteDescription("stories/PROJ-S7.md", story), labels: ["Frontend", "customer", "status:Doing"] }];
    }
    if (req.method === "PUT") return {};
  });
  try {
    await captureLogs(() => runForwardSyncGitLab({}, management));
    const update = api.calls.find((c) => c.method === "PUT" && c.body.title);
    assert.deepEqual(update.body.labels, ["customer", "Frontend", "status:Done"]);
  } finally {
    api.restore();
  }
});

test("duplicate issues for one CARD_ID: forward updates and reverse reads the open one with the lowest iid", async () => {
  const story = cardMarkdown({ id: "PROJ-S10", status: "Backlog" });
  resetCards({ "stories/PROJ-S10.md": story });
  const description = remoteDescription("stories/PROJ-S10.md", story);
  const issues = [
    { iid: 30, state: "opened", description, labels: ["status:Doing"] },
    { iid: 7, state: "closed", description, labels: ["status:Done"] },
    { iid: 12, state: "opened", description, labels: ["status:Backlog"] },
  ];
  let api = gitlabApi((req) => {
    if (req.method === "GET") return issues;
    if (req.method === "PUT" && req.path === `${issuesPath}/12`) return {};
  });
  try {
    const actions = actionsFrom(await captureLogs(() => runForwardSyncGitLab({}, management)));
    assert.equal(actions[0].action, "UPDATED");
    assert.equal(actions[0].gitlabIssueIid, 12);
  } finally {
    api.restore();
  }

  resetCards({ "stories/PROJ-S10.md": cardMarkdown({ id: "PROJ-S10", status: "To do" }) });
  api = gitlabApi(() => issues);
  try {
    const lines = await captureLogs(() => runReverseSyncGitLab({}, management));
    assert.ok(lines.some((l) => l.includes("GitLab issues found: 3")));
    assert.ok(lines.some((l) => l.includes("Ignored 2 duplicate issue(s): another issue carries the same CARD_ID.")));
    assert.match(ws.read(".github/cards/stories/PROJ-S10.md"), /status: "?Backlog"?/, "read from #12, not #30 (Doing) or #7 (Done)");
    assert.ok(lines.some((l) => l.includes("Patched: .github/cards/stories/PROJ-S10.md (GitLab #12)")));
    assert.ok(!lines.some((l) => l.includes("(GitLab #30)") || l.includes("(GitLab #7)")));
  } finally {
    api.restore();
  }
});
