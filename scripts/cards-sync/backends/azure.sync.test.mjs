import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { cardMarkdown, captureLogs, jsonResponse, mockFetch, setupWorkspace } from "./sync-fixture.mjs";

const ws = setupWorkspace();
const { runForwardSyncAzure, runReverseSyncAzure } = await import("./azure.mjs");
const { buildRemoteDescriptionFromCard, parseCardFile } = await import("../lib.mjs");

const management = {
  azureOrgUrl: "https://dev.azure.com/acme/",
  azureProject: "My Project",
  azurePat: "az-pat",
  statusMap: { "In progress": "Active" },
};
const projectUrl = "https://dev.azure.com/acme/My%20Project";

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

/** REST router: `route(req)` gets the request plus `endpoint` (URL path after the project). */
function azureApi(route) {
  return mockFetch((req) => {
    assert.ok(req.url.startsWith(`${projectUrl}/`), `unexpected Azure URL ${req.url}`);
    assert.equal(req.headers.Authorization, `Basic ${Buffer.from(":az-pat").toString("base64")}`);
    assert.equal(req.headers.Accept, "application/json");
    return route({ ...req, endpoint: req.url.slice(projectUrl.length) });
  });
}

test.after(() => ws.cleanup());

test("forward and reverse refuse to run without org url, project and PAT", async () => {
  await assert.rejects(runForwardSyncAzure({}, {}), /AZDO_ORG_URL, AZDO_PROJECT, and AZDO_PAT/);
  await assert.rejects(runForwardSyncAzure({}, { azureOrgUrl: "u", azureProject: "p" }), /AZDO_PAT/);
  await assert.rejects(runReverseSyncAzure({}, { azureOrgUrl: "u", azurePat: "x" }), /AZDO_ORG_URL, AZDO_PROJECT, and AZDO_PAT/);
});

test("forward creates new work items, updates existing ones, sets state and links child to parent", async () => {
  const feature = cardMarkdown({ id: "PROJ-F1", type: "Feature", status: "In progress" });
  const story = cardMarkdown({ id: "PROJ-S1", parent: "PROJ-F1", status: "Done" });
  resetCards({ "features/PROJ-F1.md": feature, "stories/PROJ-F1/PROJ-S1.md": story });

  const created = [];
  const patches = [];
  const api = azureApi((req) => {
    if (req.method === "POST" && req.endpoint === "/_apis/wit/wiql?api-version=7.0") {
      assert.equal(req.headers["Content-Type"], "application/json");
      if (!req.body.query.includes("'CARD_ID: PROJ-F1'")) return { workItems: [] };
      return { workItems: [{}, { id: 200 }, { id: 101 }] };
    }
    if (req.method === "GET" && req.endpoint === "/_apis/wit/workitems/200?api-version=7.0&fields=System.Description") {
      const near = cardMarkdown({ id: "PROJ-F10", type: "Feature" });
      return { id: 200, fields: { "System.Description": remoteDescription("features/PROJ-F10.md", near) } };
    }
    if (req.method === "GET" && req.endpoint === "/_apis/wit/workitems/101?api-version=7.0&fields=System.Description") {
      return { id: 101, fields: { "System.Description": remoteDescription("features/PROJ-F1.md", feature) } };
    }
    if (req.method === "POST" && /^\/_apis\/wit\/workitems\/(\$|%24)?Task\?api-version=7\.0$/.test(req.endpoint)) {
      assert.equal(req.headers["Content-Type"], "application/json-patch+json");
      created.push(req.body);
      return { id: 102 };
    }
    const patch = req.endpoint.match(/^\/_apis\/wit\/workitems\/(\d+)\?api-version=7\.0$/);
    if (req.method === "PATCH" && patch) {
      assert.equal(req.headers["Content-Type"], "application/json-patch+json");
      patches.push({ id: Number(patch[1]), ops: req.body });
      return new Response(null, { status: 204 });
    }
  });
  try {
    const lines = await captureLogs(() => runForwardSyncAzure({}, management));
    const actions = actionsFrom(lines);

    assert.equal(created.length, 1);
    assert.deepEqual(
      created[0].map((op) => op.path),
      ["/fields/System.Title", "/fields/System.Description"]
    );
    assert.equal(created[0][0].value, "[Story] Card PROJ-S1");
    assert.match(created[0][1].value, /CARD_ID: PROJ-S1/);

    assert.deepEqual(
      actions.map((a) => `${a.action}:${a.cardId || a.child}`),
      ["UPDATED:PROJ-F1", "STATUS_SET:PROJ-F1", "CREATED:PROJ-S1", "STATUS_SET:PROJ-S1", "LINKED:102"]
    );
    assert.equal(actions[0].workItemId, 101, "PROJ-F10 candidate is not mistaken for PROJ-F1");
    assert.equal(actions[1].azureState, "Active", "statusMap maps In progress → Active");
    assert.equal(actions[3].azureState, "Done", "unmapped status is sent as-is");
    assert.deepEqual(actions[4], { action: "LINKED", parent: 101, child: 102 });

    const update = patches.find((p) => p.id === 101 && p.ops.some((op) => op.path === "/fields/System.Title"));
    assert.equal(update.ops[0].value, "[Feature] Card PROJ-F1");
    assert.ok(patches.some((p) => p.id === 101 && p.ops[0].path === "/fields/System.State" && p.ops[0].value === "Active"));
    const link = patches.find((p) => p.id === 102 && p.ops[0].path === "/relations/-");
    assert.equal(link.ops[0].value.rel, "System.LinkTypes.Hierarchy-Reverse");
    assert.equal(link.ops[0].value.url, "https://dev.azure.com/acme/My%20Project/_apis/wit/workitems/101");

    assert.ok(lines.some((l) => l.includes("Parent-child links: 1")));
    assert.ok(lines.some((l) => l.includes("=== AZURE DEVOPS SYNC COMPLETE ===")));
  } finally {
    api.restore();
  }
});

test("forward keeps going when a state is rejected, linking fails, or a create returns no id", async () => {
  resetCards({
    "features/PROJ-F2.md": cardMarkdown({ id: "PROJ-F2", type: "Feature", status: "Blocked by legal" }),
    "stories/PROJ-S2.md": cardMarkdown({ id: "PROJ-S2", parent: "PROJ-F2" }),
    "stories/PROJ-S3.md": cardMarkdown({ id: "PROJ-S3", parent: "PROJ-F9" }),
    "tasks/PROJ-T1.md": cardMarkdown({ id: "PROJ-T1", type: "Task", parent: "PROJ-S3" }),
  });
  const ids = { "PROJ-F2": 11, "PROJ-S2": 12 };
  const createdTypes = [];
  const api = azureApi((req) => {
    if (req.endpoint.startsWith("/_apis/wit/wiql")) return { workItems: [] };
    if (req.method === "POST" && req.endpoint.startsWith("/_apis/wit/workitems/")) {
      createdTypes.push(req.endpoint);
      const cardId = req.body[1].value.match(/CARD_ID: (\S+)/)[1];
      return ids[cardId] ? { id: ids[cardId] } : {};
    }
    if (req.method === "PATCH") {
      const op = req.body[0];
      if (op.path === "/fields/System.State" && op.value === "Blocked by legal") {
        return jsonResponse({ message: "TF401320: State 'Blocked by legal' is not valid" }, 400);
      }
      if (op.path === "/relations/-") return new Response("upstream exploded", { status: 500 });
      return {};
    }
  });
  try {
    const lines = await captureLogs(() => runForwardSyncAzure({}, { ...management, azureWorkItemType: "User Story", statusMap: undefined }));
    const actions = actionsFrom(lines);

    assert.equal(createdTypes.length, 4);
    assert.ok(createdTypes.every((e) => /^\/_apis\/wit\/workitems\/(\$|%24)?User%20Story\?api-version=7\.0$/.test(e)));
    const skipped = actions.find((a) => a.action === "STATUS_SKIPPED");
    assert.equal(skipped.cardId, "PROJ-F2");
    assert.equal(skipped.applied, false);
    assert.equal(skipped.azureState, "Blocked by legal");
    assert.match(skipped.reason, /Azure request failed \(400\b.*TF401320/);

    const linkFailed = actions.find((a) => a.action === "LINK_FAILED");
    assert.deepEqual({ parent: linkFailed.parent, child: linkFailed.child }, { parent: 11, child: 12 });
    assert.match(linkFailed.reason, /\(500\b.*"raw":"upstream exploded"/);

    const noId = actions.filter((a) => a.workItemId === null);
    assert.deepEqual(noId.map((a) => `${a.action}:${a.cardId}`), ["CREATED:PROJ-S3", "CREATED:PROJ-T1"]);
    assert.ok(!actions.some((a) => a.action === "STATUS_SET" && a.cardId === "PROJ-S3"), "no state PATCH without a work item id");
    assert.equal(actions.filter((a) => a.action.startsWith("LINK")).length, 1, "edges with an unknown work item are skipped");
  } finally {
    api.restore();
  }
});

test("forward surfaces the Azure API error instead of continuing silently", async () => {
  resetCards({ "stories/PROJ-S4.md": cardMarkdown({ id: "PROJ-S4" }) });
  const api = mockFetch(() => jsonResponse({ message: "TF400813: not authorized" }, 401));
  try {
    await assert.rejects(captureLogs(() => runForwardSyncAzure({}, management)), /Azure request failed \(401\b[\s\S]*TF400813/);
  } finally {
    api.restore();
  }
});

test("forward says what to do when there are no cards, or only kit samples", async () => {
  resetCards({});
  const api = mockFetch(() => undefined);
  try {
    assert.ok((await captureLogs(() => runForwardSyncAzure({}, management))).some((l) => l.includes("No valid cards found for Azure mode.")));
    resetCards({ "stories/EXAMPLE-STORY-9.md": cardMarkdown({ id: "EXAMPLE-STORY-9" }) });
    const lines = await captureLogs(() => runForwardSyncAzure({}, management));
    assert.ok(lines.some((l) => l.includes("No cards to sync.")));
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("reverse patches local cards, recreates missing ones, skips samples, unmarked and invalid cards", async () => {
  const local = cardMarkdown({ id: "PROJ-S5", status: "Backlog" });
  const missing = cardMarkdown({ id: "PROJ-S6", title: "Recreated from board" });
  const broken = cardMarkdown({ id: "PROJ-S7" });
  const sample = cardMarkdown({ id: "EXAMPLE-STORY-1" });
  resetCards({ "stories/PROJ-S5.md": local, "stories/PROJ-S7.md": "no frontmatter here\n" });

  const items = [
    {
      id: 501,
      fields: {
        "System.Title": "[Story] Card PROJ-S5",
        "System.Description": remoteDescription("stories/PROJ-S5.md", local),
        "System.State": "Active",
        "System.ChangedDate": "2026-01-02T03:04:05Z",
      },
    },
    { id: 502, fields: { "System.Title": "No marker", "System.Description": "plain text" } },
    { id: 503 },
    {
      id: 504,
      fields: {
        "System.Title": "[Story] Recreated from board",
        "System.Description": remoteDescription("stories/PROJ-S6.md", missing),
        "System.State": "Done",
        "System.Tags": "Backend; Frontend;",
      },
    },
    { id: 505, fields: { "System.Title": "Sample", "System.Description": remoteDescription("stories/EXAMPLE-STORY-1.md", sample), "System.State": "Done" } },
    { id: 506, fields: { "System.Title": "[Story] Card PROJ-S7", "System.Description": remoteDescription("stories/PROJ-S7.md", broken), "System.State": "Done" } },
  ];
  const api = azureApi((req) => {
    if (req.method === "POST" && req.endpoint === "/_apis/wit/wiql?api-version=7.0&$top=100") {
      assert.match(req.body.query, /CONTAINS 'CARD_ID:'/);
      return { workItems: [...items.map((i) => ({ id: i.id })), {}] };
    }
    if (req.method === "POST" && req.endpoint === "/_apis/wit/workitemsbatch?api-version=7.0") {
      assert.deepEqual(req.body.ids, items.map((i) => i.id), "work items without an id are dropped");
      assert.ok(req.body.fields.includes("System.ChangedDate"));
      return { value: items };
    }
  });
  try {
    const lines = await captureLogs(() => runReverseSyncAzure({}, management));
    assert.ok(lines.some((l) => l.includes("Direction: reverse (Azure -> Markdown)")));
    assert.ok(lines.some((l) => l.includes("Azure work items found: 6")));

    const patched = ws.read(".github/cards/stories/PROJ-S5.md");
    assert.match(patched, /status: "?In progress"?/, "statusMap is applied in reverse (Active → In progress)");
    assert.match(patched, /board_sync_at: "?2026-01-02T03:04:05.000Z"?/);
    assert.ok(lines.some((l) => l.includes("Patched: .github/cards/stories/PROJ-S5.md (Azure #501)")));

    const recreated = ws.read(".github/cards/stories/PROJ-S6.md");
    assert.match(recreated, /status: "?Done"?/);
    assert.match(recreated, /Backend/);
    assert.ok(!ws.exists(".github/cards/stories/EXAMPLE-STORY-1.md"));
    assert.equal(ws.read(".github/cards/stories/PROJ-S7.md"), "no frontmatter here\n", "invalid local card is left alone");

    assert.ok(lines.some((l) => l.includes("SKIP (invalid frontmatter): .github/cards/stories/PROJ-S7.md (Azure #506)")));
    assert.ok(lines.some((l) => l.includes("Skipped 1 kit sample work item(s).")));
    assert.ok(lines.some((l) => l.includes("Azure reverse sync wrote: 2 file(s)")));
    assert.ok(lines.some((l) => l.includes("Skipped: 1 work item(s).")));

    const again = await captureLogs(() => runReverseSyncAzure({}, management));
    assert.ok(again.some((l) => l.includes("Unchanged: 2 card(s).")));
    assert.ok(again.some((l) => l.includes("Azure reverse sync wrote: 0 file(s)")));
  } finally {
    api.restore();
  }
});

test("reverse surfaces the API error, including non-JSON bodies", async () => {
  const api = mockFetch(() => new Response("Bad gateway", { status: 502, statusText: "Bad Gateway" }));
  try {
    await assert.rejects(captureLogs(() => runReverseSyncAzure({}, management)), /Azure request failed \(502 Bad Gateway\): \{"raw":"Bad gateway"\}/);
  } finally {
    api.restore();
  }
});

test("reverse with no matching work items says so", async () => {
  const api = azureApi(() => new Response("", { status: 200 }));
  try {
    const lines = await captureLogs(() => runReverseSyncAzure({}, management));
    assert.ok(lines.some((l) => l.includes("No Azure work items with CARD_ID found.")));
    assert.equal(api.calls.length, 1, "no batch request when the WIQL finds nothing");
  } finally {
    api.restore();
  }
});
