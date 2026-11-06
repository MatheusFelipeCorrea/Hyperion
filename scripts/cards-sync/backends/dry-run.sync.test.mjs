import test from "node:test";
import assert from "node:assert/strict";
import { cardMarkdown, captureLogs, mockFetch, setupWorkspace } from "./sync-fixture.mjs";

const existing = cardMarkdown({ id: "PROJ-D1", status: "Backlog" });
const fresh = cardMarkdown({ id: "PROJ-D2" });
const ws = setupWorkspace({ "stories/PROJ-D1.md": existing, "stories/PROJ-D2.md": fresh }, { dryRun: true });
const { runForwardSyncLinear, runReverseSyncLinear } = await import("./linear.mjs");
const { runForwardSyncAzure } = await import("./azure.mjs");
const { runForwardSyncGitLab } = await import("./gitlab.mjs");
const { runForwardSyncJira } = await import("./jira.mjs");
const { buildRemoteDescriptionFromCard, parseCardFile } = await import("../lib.mjs");

const remoteDescription = (rel, content) => buildRemoteDescriptionFromCard(parseCardFile(content, `.github/cards/${rel}`));

test.after(() => ws.cleanup());

test("Linear dry-run plans CREATE/UPDATE without writing anything", async () => {
  const api = mockFetch((req) => {
    const { query, variables } = req.body;
    assert.doesNotMatch(query, /mutation/, "dry-run never mutates");
    const nodes = variables.marker === "CARD_ID: PROJ-D1" ? [{ id: "lin-D1", description: remoteDescription("stories/PROJ-D1.md", existing) }] : [];
    return { data: { team: { issues: { nodes, pageInfo: { hasNextPage: false } } } } };
  });
  try {
    const lines = await captureLogs(() => runForwardSyncLinear({}, { linearTeamId: "t", linearApiToken: "k" }));
    const actions = lines.filter((l) => l.includes('"action"')).map((l) => JSON.parse(l.replace(/^\[cards-sync\] /, "")));
    assert.deepEqual(
      actions.map((a) => [a.action, a.cardId, a.linearIssueId]),
      [
        ["UPDATE", "PROJ-D1", "lin-D1"],
        ["CREATE", "PROJ-D2", null],
      ]
    );
  } finally {
    api.restore();
  }
});

function plannedActions(lines) {
  return lines.filter((l) => l.includes('"action"')).map((l) => JSON.parse(l.replace(/^\[cards-sync\] /, "")));
}

test("Azure and GitLab dry-runs only search, then plan CREATE for every card", async () => {
  const api = mockFetch((req) => {
    assert.ok(req.method === "GET" || req.url.includes("/wiql"), `dry-run must not write: ${req.method} ${req.url}`);
    return req.url.includes("/wiql") ? { workItems: [] } : [];
  });
  try {
    const azure = plannedActions(await captureLogs(() => runForwardSyncAzure({}, { azureOrgUrl: "https://dev.azure.com/acme", azureProject: "P", azurePat: "pat" })));
    assert.deepEqual(azure.map((a) => [a.action, a.cardId, a.workItemId]), [
      ["CREATE", "PROJ-D1", null],
      ["CREATE", "PROJ-D2", null],
    ]);
    const gitlab = plannedActions(await captureLogs(() => runForwardSyncGitLab({}, { gitlabProjectId: "acme/app", gitlabToken: "t" })));
    assert.deepEqual(gitlab.map((a) => [a.action, a.cardId, a.status]), [
      ["CREATE", "PROJ-D1", "Backlog"],
      ["CREATE", "PROJ-D2", "Backlog"],
    ]);
  } finally {
    api.restore();
  }
});

test("Jira dry-run prints the plan and never calls the API", async () => {
  const api = mockFetch(() => assert.fail("Jira dry-run must not call the API"));
  try {
    const lines = await captureLogs(() =>
      runForwardSyncJira({}, { jiraUrl: "https://acme.atlassian.net", jiraProjectKey: "PROJ", jiraEmail: "a@b.c", jiraApiToken: "t" })
    );
    assert.ok(lines.some((l) => l.includes("Dry-run in Jira mode: no remote changes applied.")));
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("Linear reverse dry-run reports the patch and the create it would do", async () => {
  const gone = cardMarkdown({ id: "PROJ-D3" });
  const api = mockFetch(() => ({
    data: {
      team: {
        issues: {
          nodes: [
            { id: "i1", title: "Card PROJ-D1", description: remoteDescription("stories/PROJ-D1.md", existing), state: { name: "Done" }, labels: { nodes: [] } },
            { id: "i3", title: "Card PROJ-D3", description: remoteDescription("stories/PROJ-D3.md", gone), state: { name: "Done" }, labels: { nodes: [] } },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  }));
  try {
    const before = ws.read(".github/cards/stories/PROJ-D1.md");
    const lines = await captureLogs(() => runReverseSyncLinear({}, { linearTeamId: "t", linearApiToken: "k" }));
    assert.ok(lines.some((l) => l.includes("Would patch frontmatter: .github/cards/stories/PROJ-D1.md")));
    assert.ok(lines.some((l) => l.includes("Would create: .github/cards/stories/PROJ-D3.md")));
    assert.equal(ws.read(".github/cards/stories/PROJ-D1.md"), before);
    assert.equal(ws.exists(".github/cards/stories/PROJ-D3.md"), false);
  } finally {
    api.restore();
  }
});
