import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  parseCardFile,
  parseSubIssueIds,
  extractCardIdFromReference,
  formatCardReference,
  enrichBodySubIssues,
  beautifyCardBodyForDisplay,
  buildIssueBody,
  buildEdges,
  resolveMappedOptionValue,
  canonicalizeRemoteOption,
  buildOptionCandidates,
  pickSingleSelectOption,
  pickIterationOption,
  resolveSprintFieldConfig,
  pickJiraTransition,
  buildJiraDescription,
  parseSyncMetadataFromDescription,
  parseIssueSummaryTypeTitle,
  jiraIssueToCardMarkdown,
  remoteIssueToCardMarkdown,
  resolveMappedStatus,
  resolveGitLabStatusAction,
  jiraRequest,
  graphql,
  patchCardFrontmatter,
  buildRemoteFrontmatterUpdates,
  resolveHyperionStatusFromRemote,
  canonicalizeLinearState,
  getLabelId,
  shouldPromptBeforeLiveSync,
} from "./sync.mjs";
import { pickCanonicalIssueForCardId } from "./lib.mjs";

test("parseFrontmatter reads scalar and array values", () => {
  const content = `---
card_id: EXAMPLE-1
title: "Example"
story_points: 3
categories:
  - Backend
  - Frontend
---

# Body
`;
  const parsed = parseFrontmatter(content);
  assert.ok(parsed);
  assert.equal(parsed.meta.card_id, "EXAMPLE-1");
  assert.equal(parsed.meta.story_points, 3);
  assert.deepEqual(parsed.meta.categories, ["Backend", "Frontend"]);
});

test("parseCardFile extracts canonical card structure", () => {
  const content = `---
card_id: EXAMPLE-2
title: "Story title"
type: Story
priority: High
status: Backlog
story_points: 5
parent: EXAMPLE-1
---

# Story title
`;
  const card = parseCardFile(content, ".github/cards/stories/EXAMPLE-2.md");
  assert.ok(card);
  assert.equal(card.cardId, "EXAMPLE-2");
  assert.equal(card.storyPoints, 5);
  assert.equal(card.parent, "EXAMPLE-1");
});

test("parseSubIssueIds reads bullet IDs under Sub-issues section", () => {
  const body = `
## Sub-issues
- EXAMPLE-CHILD-1
- EXAMPLE-CHILD-2

## Another section
`;
  const ids = parseSubIssueIds(body);
  assert.deepEqual(ids, ["EXAMPLE-CHILD-1", "EXAMPLE-CHILD-2"]);
});

test("parseSubIssueIds reads card IDs from markdown issue links", () => {
  const body = `
## Sub-issues
- [EXAMPLE-CHILD-1 (#12)](https://github.com/o/r/issues/12)
`;
  assert.deepEqual(parseSubIssueIds(body), ["EXAMPLE-CHILD-1"]);
});

test("extractCardIdFromReference supports plain IDs and markdown links", () => {
  assert.equal(extractCardIdFromReference("TEST-STORY-001"), "TEST-STORY-001");
  assert.equal(
    extractCardIdFromReference("[TEST-STORY-001 (#36)](https://github.com/o/r/issues/36)"),
    "TEST-STORY-001"
  );
});

test("enrichBodySubIssues replaces sub-issue bullets with GitHub links", () => {
  const issueByCardId = new Map([
    ["TEST-STORY-001", { number: 36 }],
    ["TEST-STORY-002", { number: 37 }],
  ]);
  const body = `## Sub-issues\n\n- TEST-STORY-001\n- TEST-STORY-002\n`;
  const enriched = enrichBodySubIssues(body, issueByCardId, "acme-org", "Hyperion");
  assert.match(enriched, /\[TEST-STORY-001 \(#36\)\]\(https:\/\/github\.com\/acme-org\/Hyperion\/issues\/36\)/);
  assert.match(enriched, /\[TEST-STORY-002 \(#37\)\]/);
});

test("buildIssueBody adds Hyperion sync footer and parent links", () => {
  const card = {
    cardId: "TEST-FEATURE-001",
    relativeFile: ".github/cards/features/TEST-FEATURE-001.md",
    parent: "TEST-EPIC-001",
    body: "# Feature\n\n## Sub-issues\n\n- TEST-STORY-001\n",
  };
  const issueByCardId = new Map([
    ["TEST-EPIC-001", { number: 32 }],
    ["TEST-STORY-001", { number: 36 }],
  ]);
  const body = buildIssueBody(card, {
    issueByCardId,
    owner: "acme-org",
    name: "Hyperion",
  });

  assert.match(body, /## 👆 Parent|## Parent/);
  assert.match(body, /\[TEST-EPIC-001 \(#32\)\]/);
  assert.match(body, /\[TEST-STORY-001 \(#36\)\]/);
  assert.match(body, /🔄 Hyperion sync/);
  assert.match(body, /CARD_ID: TEST-FEATURE-001/);
  assert.match(body, /PARENT_CARD_ID: TEST-EPIC-001/);
});

test("beautifyCardBodyForDisplay adds section emojis when missing", () => {
  const body = "## Sub-issues\n- A\n\n## Resumo\n\n### CONCLUIDO\n- ok\n\n### PENDENTE\n- todo";
  const pretty = beautifyCardBodyForDisplay(body);
  assert.match(pretty, /## 🔗 Sub-issues/);
  assert.match(pretty, /## 📋 Resumo/);
  assert.match(pretty, /### ✅ Concluído/);
  assert.match(pretty, /### ⏳ Pendente/);
});

test("buildEdges merges parent field and body sub-issues without duplicates", () => {
  const cards = [
    { cardId: "PARENT", parent: null, body: "## Sub-issues\n- CHILD-2\n" },
    { cardId: "CHILD-1", parent: "PARENT", body: "" },
    { cardId: "CHILD-2", parent: "PARENT", body: "" },
  ];

  const edges = buildEdges(cards);
  assert.equal(edges.length, 2);
  assert.deepEqual(
    edges.map((e) => `${e.parentCardId}->${e.childCardId}`).sort(),
    ["PARENT->CHILD-1", "PARENT->CHILD-2"]
  );
});

test("resolveMappedOptionValue prefers optionMapByLocale then optionMap", () => {
  const repoConfig = {
    locale: "pt-BR",
    optionMapByLocale: {
      "pt-BR": {
        priority: { Highest: "Crítica" },
      },
    },
    optionMap: {
      priority: { Highest: "Critical" },
    },
  };

  assert.equal(resolveMappedOptionValue("priority", "Highest", repoConfig), "Crítica");
});

test("buildOptionCandidates includes aliases with accent-insensitive matching", () => {
  const repoConfig = {
    locale: "pt-BR",
    optionMapByLocale: {
      "pt-BR": {
        status: { "In Revision": "Em Revisão" },
      },
    },
  };

  const candidates = buildOptionCandidates("status", "In Revision", repoConfig);
  const normalized = candidates.map((value) =>
    String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  );
  assert.ok(normalized.includes("in revision"));
  assert.ok(normalized.includes("em revisao"));
});

test("pickSingleSelectOption matches mapped value on project options", () => {
  const field = {
    options: [
      { id: "1", name: "Backlog" },
      { id: "2", name: "Em Revisão" },
    ],
  };
  const repoConfig = {
    locale: "pt-BR",
    optionMapByLocale: { "pt-BR": { status: { "In Revision": "Em Revisão" } } },
  };

  const selected = pickSingleSelectOption(field, "In Revision", { fieldKey: "status", repoConfig });
  assert.equal(selected, "2");
});

test("buildJiraDescription encodes SYNC_METADATA block", () => {
  const card = {
    body: "Hello world",
    cardId: "PROJ-1",
    relativeFile: ".github/cards/epics/PROJ-1.md",
    parent: null,
    type: "Epic",
    status: "Backlog",
    priority: "Highest",
    sprint: null,
    storyPoints: 3,
    reporter: null,
    dueDate: null,
    categories: ["Backend", "Frontend"],
  };

  const desc = buildJiraDescription(card);
  assert.ok(desc.includes("<!-- SYNC_METADATA"));
  assert.ok(desc.includes("CARD_ID: PROJ-1"));
  assert.ok(desc.includes("CATEGORIES: Backend, Frontend"));
});

test("parseSyncMetadataFromDescription extracts meta and body", () => {
  const description = [
    "BODY TEXT",
    "",
    "---",
    "<!-- SYNC_METADATA — do not edit below this line -->",
    "CARD_ID: PROJ-1",
    "SOURCE_FILE: .github/cards/epics/PROJ-1.md",
    "TYPE: Epic",
    "STATUS: Backlog",
    "PRIORITY: Highest",
    "SPRINT: ",
    "STORY_POINTS: 3",
    "REPORTER: ",
    "PARENT_CARD_ID: ",
    "DUE_DATE: ",
    "CATEGORIES: Backend, Frontend",
    "<!-- /SYNC_METADATA -->",
  ].join("\n");

  const parsed = parseSyncMetadataFromDescription(description);
  assert.ok(parsed);
  assert.equal(parsed.meta.CARD_ID, "PROJ-1");
  assert.equal(parsed.bodyContent, "BODY TEXT");
});

test("parseIssueSummaryTypeTitle parses [Type] Title", () => {
  const parsed = parseIssueSummaryTypeTitle("[Epic] Login flow");
  assert.equal(parsed.type, "Epic");
  assert.equal(parsed.title, "Login flow");
});

test("jiraIssueToCardMarkdown converts issue fields into local card markdown", () => {
  const issue = {
    fields: {
      summary: "[Epic] Login flow",
      labels: ["Backend", "Frontend"],
      description: [
        "BODY TEXT",
        "",
        "---",
        "<!-- SYNC_METADATA — do not edit below this line -->",
        "CARD_ID: PROJ-EPIC-001",
        "SOURCE_FILE: .github/cards/epics/PROJ-EPIC-001.md",
        "TYPE: Epic",
        "STATUS: Backlog",
        "PRIORITY: Highest",
        "SPRINT: ",
        "STORY_POINTS: 5",
        "REPORTER: ",
        "PARENT_CARD_ID: ",
        "DUE_DATE: ",
        "CATEGORIES: Backend, Frontend",
        "<!-- /SYNC_METADATA -->",
      ].join("\n"),
    },
  };

  const converted = jiraIssueToCardMarkdown(issue);
  assert.ok(converted);
  assert.equal(converted.sourceFile, ".github/cards/epics/PROJ-EPIC-001.md");
  assert.ok(converted.markdown.includes("card_id: \"PROJ-EPIC-001\""));
  assert.ok(converted.markdown.includes("status: \"Backlog\""));
  assert.ok(converted.markdown.includes("type: \"Epic\""));
  assert.ok(converted.markdown.includes("story_points: 5"));
  assert.ok(converted.markdown.includes("# BODY TEXT") === false); // bodyContent is raw; markdown should include it at end
  assert.ok(converted.markdown.trimEnd().endsWith("BODY TEXT"));
});

test("jiraRequest attaches Basic auth and parses JSON", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      const auth = options?.headers?.Authorization || "";
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ received: url, auth: auth }),
      };
    };

    const management = {
      jiraUrl: "https://example.atlassian.net",
      jiraEmail: "user@example.com",
      jiraApiToken: "API_TOKEN",
    };

    const payload = await jiraRequest(management, "/rest/api/2/project/PROJ");
    assert.ok(payload.received.includes("/rest/api/2/project/PROJ"));
    assert.ok(String(payload.auth).startsWith("Basic "));
  } finally {
    global.fetch = originalFetch;
  }
});

test("graphql sends headers and returns payload.data (mocked fetch)", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: { hello: "world" } }),
      };
    };

    const data = await graphql("query($x:Int!){ __typename }", { x: 1 });
    assert.deepEqual(data, { hello: "world" });
  } finally {
    global.fetch = originalFetch;
  }
});

test("getLabelId creates a missing label", async () => {
  const originalFetch = global.fetch;
  try {
    let call = 0;
    global.fetch = async (url, options) => {
      call += 1;
      const body = JSON.parse(options.body);
      if (call === 1) {
        assert.match(body.query, /label\(name: \$labelName\)/);
        return {
          ok: true,
          json: async () => ({ data: { repository: { id: "REPO_ID", label: null } } }),
        };
      }
      assert.match(body.query, /createLabel/);
      return {
        ok: true,
        json: async () => ({ data: { createLabel: { label: { id: "NEW_LABEL_ID" } } } }),
      };
    };

    const id = await getLabelId("acme", "app", "bug", true);
    assert.equal(id, "NEW_LABEL_ID");
    assert.equal(call, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("getLabelId falls back to a lookup when createLabel races and loses (PR #66 regression)", async () => {
  const originalFetch = global.fetch;
  try {
    let call = 0;
    global.fetch = async (url, options) => {
      call += 1;
      const body = JSON.parse(options.body);
      if (call === 1) {
        // No label yet, per the first read.
        return {
          ok: true,
          json: async () => ({ data: { repository: { id: "REPO_ID", label: null } } }),
        };
      }
      if (call === 2) {
        assert.match(body.query, /createLabel/);
        // Another concurrent sync run created it first.
        return {
          ok: true,
          json: async () => ({
            errors: [{ message: "Name has already been taken" }],
          }),
        };
      }
      assert.match(body.query, /label\(name: \$labelName\) \{ id \}/);
      return {
        ok: true,
        json: async () => ({ data: { repository: { label: { id: "WINNER_LABEL_ID" } } } }),
      };
    };

    const id = await getLabelId("acme", "app", "bug", true);
    assert.equal(id, "WINNER_LABEL_ID");
    assert.equal(call, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("getLabelId re-throws createLabel errors unrelated to the name-taken race", async () => {
  const originalFetch = global.fetch;
  try {
    let call = 0;
    global.fetch = async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({ data: { repository: { id: "REPO_ID", label: null } } }),
        };
      }
      return { ok: true, json: async () => ({ errors: [{ message: "insufficient permissions" }] }) };
    };

    await assert.rejects(
      () => getLabelId("acme", "app", "bug", true),
      /insufficient permissions/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("pickJiraTransition matches canonical and localized status names", () => {
  const transitions = [
    { id: "1", name: "Start Progress", to: { name: "In Progress" } },
    { id: "2", name: "Done", to: { name: "Done" } },
    { id: "3", name: "Concluir", to: { name: "Concluído" } },
  ];
  const repoConfig = {
    locale: "pt-BR",
    optionMapByLocale: {
      "pt-BR": {
        status: {
          Done: "Concluído",
          "In Progress": "Em Progresso",
        },
      },
    },
  };

  const inProgress = pickJiraTransition(transitions, "In Progress", repoConfig);
  assert.equal(inProgress?.id, "1");

  const donePt = pickJiraTransition(transitions, "Done", repoConfig);
  assert.equal(donePt?.id, "3");

  const missing = pickJiraTransition(transitions, "Backlog", repoConfig);
  assert.equal(missing, null);
});

test("resolveMappedStatus uses status_map then identity", () => {
  assert.equal(resolveMappedStatus({ Done: "Closed" }, "Done"), "Closed");
  assert.equal(resolveMappedStatus({}, "In Progress"), "In Progress");
  assert.equal(resolveMappedStatus(null, null), null);
});

test("resolveGitLabStatusAction maps Done-like to close", () => {
  const done = resolveGitLabStatusAction({ Done: "Done" }, "Done");
  assert.equal(done.state_event, "close");
  const progress = resolveGitLabStatusAction({ "In Progress": "Doing" }, "In Progress");
  assert.equal(progress.state_event, "reopen");
  assert.equal(progress.label, "Doing");
});

test("remoteIssueToCardMarkdown rebuilds card from SYNC_METADATA", () => {
  const description = [
    "Body text",
    "",
    "---",
    "<!-- SYNC_METADATA — do not edit below this line -->",
    "CARD_ID: STORY-1",
    "SOURCE_FILE: .github/cards/stories/STORY-1.md",
    "TYPE: Story",
    "STATUS: In Progress",
    "CATEGORIES: Backend",
    "PARENT_CARD_ID: ",
    "STORY_POINTS: 3",
    "PRIORITY: High",
    "SPRINT: ",
    "REPORTER: ",
    "DUE_DATE: ",
    "<!-- /SYNC_METADATA -->",
  ].join("\n");
  const converted = remoteIssueToCardMarkdown({
    title: "[Story] Login SSO",
    description,
    labels: ["Backend"],
    statusOverride: "Active",
  });
  assert.ok(converted);
  assert.equal(converted.sourceFile, ".github/cards/stories/STORY-1.md");
  assert.match(converted.markdown, /card_id: "STORY-1"/);
  assert.match(converted.markdown, /status: "Active"/);
  assert.match(converted.markdown, /Login SSO/);
});

test("pickIterationOption matches iteration title exactly and fuzzily", () => {
  const field = {
    __typename: "ProjectV2IterationField",
    configuration: {
      iterations: [
        { id: "it-1", title: "Sprint 1" },
        { id: "it-2", title: "Sprint 2" },
      ],
    },
  };

  assert.equal(pickIterationOption(field, "Sprint 1"), "it-1");
  assert.equal(pickIterationOption(field, "sprint 2"), "it-2");
  assert.equal(pickIterationOption(field, null), "");
  assert.equal(pickIterationOption(field, "Sprint 99"), "");
});

test("resolveSprintFieldConfig applies defaults and seed iterations", () => {
  const defaults = resolveSprintFieldConfig({});
  assert.equal(defaults.durationDays, 14);
  assert.match(defaults.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(defaults.seedIterations, []);

  const custom = resolveSprintFieldConfig({
    sprintField: {
      durationDays: 21,
      startDate: "2026-01-01",
      seedIterations: [{ title: "Sprint 1", startDate: "2026-01-01" }],
    },
  });
  assert.equal(custom.durationDays, 21);
  assert.equal(custom.startDate, "2026-01-01");
  assert.equal(custom.seedIterations.length, 1);
});

test("canonicalizeRemoteOption maps localized Project values back to YAML English", () => {
  const repoConfig = {
    locale: "pt-BR",
    optionMapByLocale: {
      "pt-BR": {
        status: { "In Progress": "Em Progresso", Done: "Concluído" },
        priority: { Highest: "Crítica" },
      },
    },
  };
  assert.equal(canonicalizeRemoteOption("status", "Em Progresso", repoConfig), "In Progress");
  assert.equal(canonicalizeRemoteOption("status", "Concluído", repoConfig), "Done");
  assert.equal(canonicalizeRemoteOption("priority", "Crítica", repoConfig), "Highest");
});

test("pickCanonicalIssueForCardId avoids EPIC-014 vs FEAT-014 collision at map level", () => {
  const epicIssue = { number: 14, state: "OPEN", body: "CARD_ID: PULSO-EPIC-014\n<!-- /SYNC_METADATA -->" };
  const featIssue = { number: 99, state: "OPEN", body: "CARD_ID: PULSO-FEAT-014\n<!-- /SYNC_METADATA -->" };
  assert.notEqual("PULSO-EPIC-014", "PULSO-FEAT-014");
  assert.equal(pickCanonicalIssueForCardId(epicIssue, featIssue).number, 14);
});

test("patchCardFrontmatter preserves body and updates status from board", () => {
  const local = `---
card_id: "PROJ-1"
title: "Story"
status: "Backlog"
type: "Story"
priority: null
sprint: null
story_points: null
reporter: null
parent: null
due_date: null
categories: []
---

# Story body stays
`;
  const patched = patchCardFrontmatter(local, { status: "In Progress" });
  assert.ok(patched);
  assert.match(patched, /status: "In Progress"/);
  assert.match(patched, /# Story body stays/);
  assert.match(patched, /card_id: "PROJ-1"/);
});

test("buildRemoteFrontmatterUpdates reads Project field map", () => {
  const updates = buildRemoteFrontmatterUpdates(
    {
      status: "Em Progresso",
      type: "Feature",
      priority: "Crítica",
      sprint: "Sprint 2",
      storyPoints: 5,
      reporter: "alice",
      parent: "https://github.com/o/r/issues/1 (EPIC-1)",
      dueDate: "2026-03-01",
    },
    { labels: ["Backend"] },
    {
      locale: "pt-BR",
      optionMapByLocale: {
        "pt-BR": {
          status: { "In Progress": "Em Progresso" },
          type: { Feature: "Funcionalidade" },
          priority: { Highest: "Crítica" },
        },
      },
    }
  );
  assert.equal(updates.status, "In Progress");
  assert.equal(updates.type, "Feature");
  assert.equal(updates.priority, "Highest");
  assert.equal(updates.sprint, "Sprint 2");
  assert.equal(updates.story_points, 5);
  assert.equal(updates.parent, "EPIC-1");
  assert.deepEqual(updates.categories, ["Backend"]);
});

test("resolveHyperionStatusFromRemote maps via status_map inverse", () => {
  const statusMap = { Backlog: "Todo", "In Progress": "Doing" };
  assert.equal(resolveHyperionStatusFromRemote("Doing", statusMap, {}), "In Progress");
  assert.equal(resolveHyperionStatusFromRemote("Todo", statusMap, {}), "Backlog");
});

test("shouldPromptBeforeLiveSync only fires for an interactive, unattended, non-dry-run invocation", () => {
  // dry-run: never prompt, no matter how the rest looks
  assert.equal(
    shouldPromptBeforeLiveSync({ dryRun: true, isTTY: true, argv: [], env: {} }),
    false
  );
  // no TTY (CI, or piped): never prompt — this is what keeps ci-sync.mjs
  // and hyperion-sync-cards.yml's production push-triggered sync silent
  assert.equal(
    shouldPromptBeforeLiveSync({ dryRun: false, isTTY: false, argv: [], env: {} }),
    false
  );
  // --yes explicitly opts out
  assert.equal(
    shouldPromptBeforeLiveSync({ dryRun: false, isTTY: true, argv: ["--yes"], env: {} }),
    false
  );
  // CARDS_SYNC_YES=true explicitly opts out — this is what watch.mjs's
  // live mode sets, so an already-confirmed watcher never re-prompts
  assert.equal(
    shouldPromptBeforeLiveSync({ dryRun: false, isTTY: true, argv: [], env: { CARDS_SYNC_YES: "true" } }),
    false
  );
  // the actual risky case: real write, human at a terminal, no opt-out — prompt
  assert.equal(
    shouldPromptBeforeLiveSync({ dryRun: false, isTTY: true, argv: [], env: {} }),
    true
  );
});

test("canonicalizeLinearState aliases resolveHyperionStatusFromRemote", () => {
  const statusMap = { Done: "Completed" };
  assert.equal(canonicalizeLinearState("Completed", statusMap, {}), "Done");
});
