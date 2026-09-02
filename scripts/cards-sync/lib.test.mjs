import test from "node:test";
import assert from "node:assert/strict";
import {
  pickBestGitHubProject,
  expandCardIdsWithParents,
  filterEdgesForCards,
  parseOnlyFilter,
  cardIdFromRelativePath,
  isExampleCardId,
  isKitSampleCardId,
  isKitSampleRemoteArtifact,
  filterKitSampleCards,
  filterExampleSampleCards,
  shouldIncludeKitSamples,
  resolveCardRelativePath,
  checkCardPathLayout,
  CARD_TYPE_DIR,
  parseCardIdFromIssueBody,
  parseSourceFileFromIssueBody,
  pickCanonicalIssueForCardId,
  resolveSourceFileCandidates,
  parseCardIdFromRemoteDescription,
  assertCiProjectConfigured,
  readSyncBackendHint,
  parseLabelsCatalogJson,
  normalizeLabelEntry,
  labelNamesFromCatalog,
  colorFromString,
} from "./lib.mjs";

test("pickBestGitHubProject prefers Hyperion title", () => {
  const projects = [
    { number: 1, title: "Random Board" },
    { number: 7, title: "myrepo Hyperion Project" },
  ];
  const picked = pickBestGitHubProject(projects, "myrepo");
  assert.equal(picked.number, 7);
});

test("pickBestGitHubProject uses single project when only one exists", () => {
  const projects = [{ number: 3, title: "Solo Project" }];
  assert.equal(pickBestGitHubProject(projects, "repo").number, 3);
});

test("pickBestGitHubProject returns null when ambiguous", () => {
  const projects = [
    { number: 1, title: "A" },
    { number: 2, title: "B" },
  ];
  assert.equal(pickBestGitHubProject(projects, "repo"), null);
});

test("expandCardIdsWithParents includes parent chain", () => {
  const cards = [
    { cardId: "EPIC-1", parent: null },
    { cardId: "STORY-1", parent: "EPIC-1" },
    { cardId: "TASK-1", parent: "STORY-1" },
  ];
  const expanded = expandCardIdsWithParents(cards, ["TASK-1"]);
  assert.deepEqual(expanded.map((c) => c.cardId).sort(), ["EPIC-1", "STORY-1", "TASK-1"]);
});

test("filterEdgesForCards keeps only internal edges", () => {
  const edges = [
    { parentCardId: "A", childCardId: "B" },
    { parentCardId: "B", childCardId: "C" },
  ];
  const filtered = filterEdgesForCards(edges, ["A", "B"]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].childCardId, "B");
});

test("parseOnlyFilter reads --only argv", () => {
  const ids = parseOnlyFilter(["node", "sync.mjs", "--only", "A-1,B-2"]);
  assert.deepEqual(ids, ["A-1", "B-2"]);
});

test("cardIdFromRelativePath extracts basename", () => {
  assert.equal(cardIdFromRelativePath("stories/PROJ-STORY-001.md"), "PROJ-STORY-001");
});

test("filterKitSampleCards skips EXAMPLE/TEMPLATE/SAMPLE card IDs", () => {
  const cards = [
    { cardId: "EXAMPLE-EPIC-001" },
    { cardId: "TEMPLATE-DRAFT-001" },
    { cardId: "PROJ-STORY-001" },
  ];
  const result = filterKitSampleCards(cards, null, { includeSamples: false });
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.cards.map((c) => c.cardId), ["PROJ-STORY-001"]);
});

test("filterKitSampleCards never syncs samples even with --only EXAMPLE", () => {
  const cards = [{ cardId: "EXAMPLE-STORY-001" }, { cardId: "PROJ-1" }];
  const result = filterKitSampleCards(cards, ["EXAMPLE-STORY-001"], { includeSamples: false });
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.ignoredOnlyTargets, ["EXAMPLE-STORY-001"]);
  assert.deepEqual(result.cards.map((c) => c.cardId), ["PROJ-1"]);
});

test("isKitSampleRemoteArtifact skips EXAMPLE ids, _examples, and PR templates", () => {
  assert.equal(
    isKitSampleRemoteArtifact({ cardId: "EXAMPLE-EPIC-001", sourceFile: ".github/cards/epics/X.md" }),
    true
  );
  assert.equal(
    isKitSampleRemoteArtifact({
      cardId: "PROJ-1",
      sourceFile: ".github/cards/_examples/stories/EXAMPLE-FEATURE-001/EXAMPLE-STORY-001.md",
    }),
    true
  );
  assert.equal(
    isKitSampleRemoteArtifact({
      cardId: "PROJ-1",
      sourceFile: ".github/PULL_REQUEST_TEMPLATE.md",
    }),
    true
  );
  assert.equal(
    isKitSampleRemoteArtifact({ cardId: "PROJ-EPIC-001", sourceFile: ".github/cards/epics/PROJ-EPIC-001.md" }),
    false
  );
  assert.equal(
    isKitSampleRemoteArtifact(
      { cardId: "EXAMPLE-1", sourceFile: ".github/cards/_examples/x.md" },
      { includeSamples: true }
    ),
    false
  );
});

test("shouldIncludeKitSamples respects maintainer flag", () => {
  assert.equal(shouldIncludeKitSamples(["node", "sync.mjs", "--include-samples"]), true);
  assert.equal(isKitSampleCardId("SAMPLE-001"), true);
  assert.equal(isKitSampleCardId("PROJ-EPIC-001"), false);
});

test("resolveCardRelativePath nests non-epics under parent card_id", () => {
  assert.equal(
    resolveCardRelativePath({ type: "Epic", cardId: "EPIC-1", parent: null }),
    ".github/cards/epics/EPIC-1.md"
  );
  assert.equal(
    resolveCardRelativePath({ type: "Feature", cardId: "FEAT-1", parent: "EPIC-1" }),
    ".github/cards/features/EPIC-1/FEAT-1.md"
  );
  assert.equal(
    resolveCardRelativePath({ type: "Story", cardId: "STORY-1", parent: "FEAT-1" }),
    ".github/cards/stories/FEAT-1/STORY-1.md"
  );
  assert.equal(
    resolveCardRelativePath({ type: "Task", cardId: "TASK-1", parent: "STORY-1" }),
    ".github/cards/tasks/STORY-1/TASK-1.md"
  );
  assert.equal(
    resolveCardRelativePath({ type: "Story", cardId: "STORY-X", parent: null }),
    ".github/cards/stories/_orphan/STORY-X.md"
  );
  assert.equal(CARD_TYPE_DIR.Bug, "tasks");
});

test("checkCardPathLayout flags legacy flat paths", () => {
  const nested = checkCardPathLayout(".github/cards/features/EPIC-1/FEAT-1.md", {
    type: "Feature",
    cardId: "FEAT-1",
    parent: "EPIC-1",
  });
  assert.equal(nested.ok, true);

  const flat = checkCardPathLayout(".github/cards/features/FEAT-1.md", {
    type: "Feature",
    cardId: "FEAT-1",
    parent: "EPIC-1",
  });
  assert.equal(flat.ok, false);
  assert.equal(flat.legacyFlat, true);
  assert.equal(flat.expected, ".github/cards/features/EPIC-1/FEAT-1.md");
});

test("parseCardIdFromIssueBody reads CARD_ID from SYNC_METADATA only", () => {
  const body = [
    "Body",
    "---",
    "<!-- SYNC_METADATA -->",
    "CARD_ID: PULSO-EPIC-014",
    "PARENT_CARD_ID: PULSO-FEAT-014",
    "SOURCE_FILE: .github/cards/epics/PULSO-EPIC-014.md",
    "<!-- /SYNC_METADATA -->",
  ].join("\n");
  assert.equal(parseCardIdFromIssueBody(body), "PULSO-EPIC-014");
  assert.equal(parseSourceFileFromIssueBody(body), ".github/cards/epics/PULSO-EPIC-014.md");
});

test("parseCardIdFromIssueBody does not match PARENT_CARD_ID substring", () => {
  const bodyOnlyParent = [
    "<!-- SYNC_METADATA -->",
    "PARENT_CARD_ID: PULSO-EPIC-014",
    "<!-- /SYNC_METADATA -->",
  ].join("\n");
  assert.equal(parseCardIdFromIssueBody(bodyOnlyParent), null);
});

test("pickCanonicalIssueForCardId prefers OPEN and lowest issue number", () => {
  const closed = { number: 5, state: "CLOSED" };
  const openHigh = { number: 20, state: "OPEN" };
  const openLow = { number: 8, state: "OPEN" };
  assert.equal(pickCanonicalIssueForCardId(closed, openHigh).number, 20);
  assert.equal(pickCanonicalIssueForCardId(openHigh, openLow).number, 8);
});

test("resolveSourceFileCandidates adds kit.root prefix fallback", () => {
  assert.deepEqual(
    resolveSourceFileCandidates(".github/cards/epics/X.md", { kitRootRel: "Hyperion" }),
    [".github/cards/epics/X.md", "Hyperion/.github/cards/epics/X.md"]
  );
  assert.deepEqual(
    resolveSourceFileCandidates("Hyperion/.github/cards/epics/X.md", { kitRootRel: "Hyperion" }),
    ["Hyperion/.github/cards/epics/X.md", ".github/cards/epics/X.md"]
  );
});

test("parseCardIdFromRemoteDescription uses SYNC_METADATA block", () => {
  const desc = [
    "Body",
    "<!-- SYNC_METADATA -->",
    "CARD_ID: PROJ-FEAT-014",
    "PARENT_CARD_ID: PROJ-EPIC-014",
    "<!-- /SYNC_METADATA -->",
  ].join("\n");
  assert.equal(parseCardIdFromRemoteDescription(desc), "PROJ-FEAT-014");
});

test("assertCiProjectConfigured requires projectNumber when env set", async () => {
  const prev = process.env.CARDS_CI_REQUIRE_PROJECT;
  process.env.CARDS_CI_REQUIRE_PROJECT = "true";
  try {
    const missing = await assertCiProjectConfigured("/nonexistent/projects-map.json", "org/repo");
    assert.equal(missing.ok, false);
  } finally {
    if (prev === undefined) delete process.env.CARDS_CI_REQUIRE_PROJECT;
    else process.env.CARDS_CI_REQUIRE_PROJECT = prev;
  }
});

test("assertCiProjectConfigured skips projectNumber for non-GitHub backend", async () => {
  const prev = process.env.CARDS_CI_REQUIRE_PROJECT;
  process.env.CARDS_CI_REQUIRE_PROJECT = "true";
  try {
    const result = await assertCiProjectConfigured("/nonexistent/projects-map.json", "org/repo", {
      backend: "linear",
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "not_github_backend");
  } finally {
    if (prev === undefined) delete process.env.CARDS_CI_REQUIRE_PROJECT;
    else process.env.CARDS_CI_REQUIRE_PROJECT = prev;
  }
});

test("readSyncBackendHint reads CARDS_SYNC_BACKEND env", async () => {
  const prev = process.env.CARDS_SYNC_BACKEND;
  process.env.CARDS_SYNC_BACKEND = "jira";
  try {
    assert.equal(await readSyncBackendHint({}), "jira");
  } finally {
    if (prev === undefined) delete process.env.CARDS_SYNC_BACKEND;
    else process.env.CARDS_SYNC_BACKEND = prev;
  }
});

test("parseLabelsCatalogJson accepts v1 string array", () => {
  const specs = parseLabelsCatalogJson(["Backend", "Bug"]);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].name, "Backend");
  assert.match(specs[0].color, /^[0-9a-f]{6}$/);
  assert.equal(specs[0].description, "");
});

test("parseLabelsCatalogJson accepts v2 objects with color and description", () => {
  const specs = parseLabelsCatalogJson([
    { name: "API", color: "1d4ed8", description: "REST and GraphQL" },
    "Bug",
  ]);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].color, "1d4ed8");
  assert.equal(specs[0].description, "REST and GraphQL");
  assert.equal(specs[1].name, "Bug");
});

test("normalizeLabelEntry strips hash from color", () => {
  const spec = normalizeLabelEntry({ name: "Hotfix", color: "#ea580c", description: "Urgent" });
  assert.equal(spec.color, "ea580c");
});

test("labelNamesFromCatalog returns ordered names", () => {
  const names = labelNamesFromCatalog([
    { name: "A", color: colorFromString("A"), description: "" },
    { name: "B", color: colorFromString("B"), description: "" },
  ]);
  assert.deepEqual(names, ["A", "B"]);
});
