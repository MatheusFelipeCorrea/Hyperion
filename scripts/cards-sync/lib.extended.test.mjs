import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mockFetch, jsonResponse } from "./backends/sync-fixture.mjs";
import { cleanupTempDirs, git, initRepo, makeTempDir, writeFile } from "./test-support/ci-fixture.mjs";
import * as lib from "./lib.mjs";

after(cleanupTempDirs);

function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (entries) => {
    for (const [k, v] of Object.entries(entries)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  apply(vars);
  let result;
  try {
    result = fn();
  } catch (error) {
    apply(prev);
    throw error;
  }
  if (result && typeof result.then === "function") return result.finally(() => apply(prev));
  apply(prev);
  return result;
}

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

// ---------------------------------------------------------------------------
// git / gh detection
// ---------------------------------------------------------------------------

test("detectRepoFromGit parses https and ssh GitHub remotes, null otherwise", () => {
  const dir = initRepo(makeTempDir("hyperion-lib-remote-"));
  withCwd(dir, () => {
    assert.equal(lib.detectRepoFromGit(), null, "no origin");
    git(dir, "remote", "add", "origin", "https://github.com/acme/app.git");
    assert.equal(lib.detectRepoFromGit(), "acme/app");
    git(dir, "remote", "set-url", "origin", "git@github.com:acme/ssh-app.git");
    assert.equal(lib.detectRepoFromGit(), "acme/ssh-app");
    git(dir, "remote", "set-url", "origin", "https://gitlab.example/acme/app.git");
    assert.equal(lib.detectRepoFromGit(), null);
  });
});

test("detectTokenFromGhCli returns empty string when gh is unavailable", () => {
  withEnv({ PATH: "" }, () => assert.equal(lib.detectTokenFromGhCli(), ""));
});

// ---------------------------------------------------------------------------
// argv / env filters and kit-sample policy
// ---------------------------------------------------------------------------

test("parseOnlyFilter falls back to CARDS_SYNC_ONLY, then null", () => {
  withEnv({ CARDS_SYNC_ONLY: " A-1 , ,B-2 " }, () => assert.deepEqual(lib.parseOnlyFilter(["node", "x"]), ["A-1", "B-2"]));
  withEnv({ CARDS_SYNC_ONLY: undefined }, () => {
    assert.equal(lib.parseOnlyFilter(["node", "x"]), null);
    assert.equal(lib.parseOnlyFilter(["node", "x", "--only"]), null, "--only without a value is ignored");
  });
});

test("cardIdFromRelativePath ignores README; deprecated sample aliases delegate", () => {
  assert.equal(lib.cardIdFromRelativePath("cards/README.md"), null);
  assert.equal(lib.isExampleCardId("EXAMPLE-1"), true);
  assert.equal(lib.isExampleCardId(null), false);
  assert.equal(lib.shouldIncludeExampleCards(["--include-examples"]), true);
  withEnv({ CARDS_SYNC_INCLUDE_SAMPLES: undefined, CARDS_SYNC_INCLUDE_EXAMPLES: "TRUE" }, () =>
    assert.equal(lib.shouldIncludeKitSamples([]), true)
  );
  withEnv({ CARDS_SYNC_INCLUDE_SAMPLES: undefined, CARDS_SYNC_INCLUDE_EXAMPLES: undefined }, () => {
    assert.equal(lib.shouldIncludeKitSamples([]), false);
    assert.equal(lib.isKitSampleRemoteArtifact(undefined, { argv: [] }), false);
    assert.equal(lib.isKitSampleRemoteArtifact({ cardId: "X-1" }, { argv: ["--include-samples"] }), false);
  });
  const cards = [{ cardId: "SAMPLE-1" }, { cardId: "P-1" }];
  assert.deepEqual(lib.filterExampleSampleCards(cards, ["SAMPLE-1"], { includeSamples: true }), {
    cards,
    skipped: 0,
    ignoredOnlyTargets: [],
  });
  assert.equal(lib.filterExampleSampleCards(cards, null, { includeSamples: false }).skipped, 1);
});

test("isNonSyncCardPath flags templates, _examples and GitHub templates", () => {
  assert.equal(lib.isNonSyncCardPath("cards\\stories\\x.template.md"), true);
  assert.equal(lib.isNonSyncCardPath(".github/ISSUE_TEMPLATE/bug.md"), true);
  assert.equal(lib.isNonSyncCardPath(".github/pull_request_template.md"), true);
  assert.equal(lib.isNonSyncCardPath("docs/pull_request_template.md"), true);
  assert.equal(lib.isNonSyncCardPath(".github/cards/stories/S-1.md"), false);
  assert.equal(lib.isNonSyncCardPath(undefined), false);
});

test("resolveCardRelativePath / checkCardPathLayout edge cases", () => {
  assert.throws(() => lib.resolveCardRelativePath({ cardId: " " }), /cardId is required/);
  assert.throws(() => lib.resolveCardRelativePath(), /cardId is required/);
  assert.equal(
    lib.resolveCardRelativePath({ type: "Weird", cardId: "X", parent: "", cardsPrefix: "Hyperion\\.github\\cards\\" }),
    "Hyperion/.github/cards/stories/_orphan/X.md"
  );
  const misplaced = lib.checkCardPathLayout(".github/cards/stories/OTHER/S-1.md", { type: "Story", cardId: "S-1", parent: "F-1", cardsPrefix: null });
  assert.deepEqual(misplaced, { ok: false, expected: ".github/cards/stories/F-1/S-1.md", legacyFlat: false });
});

test("listCardsMarkdownFiles skips config/synced/README/templates and _examples only for sync", async () => {
  const root = makeTempDir("hyperion-lib-list-");
  for (const rel of ["stories/S-1.md", "stories/README.md", "stories/x.template.md", "config/c.md", "synced/s.md", "_examples/E.md", "notes.txt"]) {
    writeFile(root, rel, "x");
  }
  const rel = (files) => files.map((f) => f.slice(root.length + 1).replace(/\\/g, "/")).sort();
  assert.deepEqual(rel(await lib.listCardsMarkdownFiles(root)), ["_examples/E.md", "stories/S-1.md"]);
  assert.deepEqual(rel(await lib.listCardsMarkdownFiles(root, { forSync: true })), ["stories/S-1.md"]);
  assert.deepEqual(await lib.listCardsMarkdownFiles(join(root, "missing")), []);
});

test("expandCardIdsWithParents returns all cards without a filter; parent chain may leave the set", () => {
  const cards = [{ cardId: "A", parent: "GONE" }];
  assert.equal(lib.expandCardIdsWithParents(cards, null), cards);
  assert.deepEqual(lib.expandCardIdsWithParents(cards, ["A"]), cards);
});

test("pickBestGitHubProject handles empty / non-array input and a sole hyperion board", () => {
  assert.equal(lib.pickBestGitHubProject([], "x"), null);
  assert.equal(lib.pickBestGitHubProject(null, "x"), null);
  assert.equal(lib.pickBestGitHubProject([{ number: 1 }, { number: 2, title: "Team hyperion" }], "repo.js").number, 2);
});

// ---------------------------------------------------------------------------
// GitHub GraphQL discovery
// ---------------------------------------------------------------------------

function graphqlRoute(handlers) {
  return mockFetch((req) => {
    assert.equal(req.url, "https://api.github.com/graphql");
    assert.equal(req.headers.Authorization, "Bearer tok");
    const { query } = req.body;
    const scope = query.includes("repository(") ? "repository" : query.includes("user(") ? "user" : "organization";
    return handlers[scope]?.(req.body.variables);
  });
}

test("githubGraphql returns data and throws on HTTP or GraphQL errors", async () => {
  let api = mockFetch(() => ({ data: { ok: 1 } }));
  try {
    assert.deepEqual(await lib.githubGraphql("tok", "query{}"), { ok: 1 });
  } finally {
    api.restore();
  }
  api = mockFetch(() => ({ errors: [{ message: "bad" }] }));
  try {
    await assert.rejects(lib.githubGraphql("tok", "query{}"), /GraphQL failed: [\s\S]*bad/);
  } finally {
    api.restore();
  }
  api = mockFetch(() => jsonResponse({ message: "nope" }, 401));
  try {
    await assert.rejects(lib.githubGraphql("tok", "query{}"), /GraphQL failed: [\s\S]*nope/);
  } finally {
    api.restore();
  }
});

test("listGitHubProjects: repo projects, then user, then organization, else empty", async () => {
  const nodes = (n) => ({ projectsV2: { nodes: [{ number: n, title: `P${n}`, id: `id${n}` }] } });
  const cases = [
    [{ repository: () => ({ data: { repository: nodes(1) } }) }, [1], 1],
    [{ repository: () => ({ errors: [{}] }), user: () => ({ data: { user: nodes(2) } }) }, [2], 2],
    [{ repository: () => ({ data: { repository: null } }), user: () => ({ errors: [{}] }), organization: () => ({ data: { organization: nodes(3) } }) }, [3], 3],
    [{ repository: () => ({ data: {} }), user: () => ({ data: { user: null } }), organization: () => ({ data: { organization: null } }) }, [], 3],
  ];
  for (const [handlers, expected, callCount] of cases) {
    const api = graphqlRoute(handlers);
    try {
      const projects = await lib.listGitHubProjects("tok", "acme", "app");
      assert.deepEqual(projects.map((p) => p.number), expected);
      assert.equal(api.calls.length, callCount);
    } finally {
      api.restore();
    }
  }
});

test("discoverGitHubProjectNumber short-circuits on config, token and opt-out", async () => {
  const base = { owner: "acme", repoName: "app", configPath: "unused", repositorySlug: "acme/app" };
  assert.deepEqual(await lib.discoverGitHubProjectNumber({ ...base, token: "tok", repoConfig: { projectNumber: "4" } }), {
    discovered: false,
    reason: "already_configured",
    projectNumber: 4,
  });
  assert.equal((await lib.discoverGitHubProjectNumber({ ...base, token: "", repoConfig: {} })).reason, "no_token");
  assert.equal(
    (await lib.discoverGitHubProjectNumber({ ...base, token: "tok", repoConfig: { autoDiscoverProject: false } })).reason,
    "auto_discover_disabled"
  );
});

test("discoverGitHubProjectNumber reports ambiguous / not_found candidates", async () => {
  const base = { token: "tok", owner: "acme", repoName: "app", configPath: "unused", repositorySlug: "acme/app", repoConfig: {} };
  let api = graphqlRoute({
    repository: () => ({ data: { repository: { projectsV2: { nodes: [{ number: 1, title: "A" }, { number: 2, title: "B" }] } } } }),
  });
  try {
    const r = await lib.discoverGitHubProjectNumber(base);
    assert.equal(r.reason, "ambiguous");
    assert.deepEqual(r.candidates, [{ number: 1, title: "A" }, { number: 2, title: "B" }]);
  } finally {
    api.restore();
  }
  api = graphqlRoute({});
  try {
    assert.deepEqual(await lib.discoverGitHubProjectNumber(base), { discovered: false, reason: "not_found", candidates: [] });
  } finally {
    api.restore();
  }
});

test("discoverGitHubProjectNumber persists the pick into projects-map.json (repo entry or default)", async () => {
  const dir = makeTempDir("hyperion-lib-discover-");
  const configPath = join(dir, "projects-map.json");
  const api = graphqlRoute({
    repository: () => ({ data: { repository: { projectsV2: { nodes: [{ number: 9, title: "app Hyperion Project" }] } } } }),
  });
  try {
    const fresh = await lib.discoverGitHubProjectNumber({ token: "tok", owner: "acme", repoName: "app", repoConfig: {}, configPath, repositorySlug: "acme/app" });
    assert.deepEqual(fresh, { discovered: true, projectNumber: 9, projectTitle: "app Hyperion Project", projectOwner: "acme" });
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { default: { projectNumber: 9, projectOwner: "acme" } });

    writeFileSync(configPath, JSON.stringify({ repositories: { "acme/app": { locale: "en" } } }));
    await lib.discoverGitHubProjectNumber({ token: "tok", owner: "acme", repoName: "app", repoConfig: { projectOwner: "org" }, configPath, repositorySlug: "acme/app" });
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(saved.repositories["acme/app"], { locale: "en", projectNumber: 9, projectOwner: "org" });
    assert.deepEqual(saved.default, undefined);

    const before = readFileSync(configPath, "utf8");
    const dry = await lib.discoverGitHubProjectNumber({ token: "tok", owner: "acme", repoName: "app", repoConfig: {}, configPath, repositorySlug: "acme/app", persist: false });
    assert.equal(dry.discovered, true);
    assert.equal(readFileSync(configPath, "utf8"), before);
  } finally {
    api.restore();
  }
});

test("saveProjectToConfig without an owner leaves projectOwner untouched", async () => {
  const dir = makeTempDir("hyperion-lib-save-");
  const configPath = join(dir, "projects-map.json");
  writeFileSync(configPath, JSON.stringify({ repositories: { "acme/app": {} } }));
  await lib.saveProjectToConfig(configPath, "acme/app", { projectNumber: 3 });
  await lib.saveProjectToConfig(configPath, "other/repo", { projectNumber: 5 });
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    repositories: { "acme/app": { projectNumber: 3 } },
    default: { projectNumber: 5 },
  });
});

// ---------------------------------------------------------------------------
// SYNC_METADATA, source files, CI config helpers
// ---------------------------------------------------------------------------

test("issue-body metadata parsing and canonical issue picking edge cases", () => {
  assert.equal(lib.parseSyncMetadataFromIssueBody("no block"), null);
  assert.equal(lib.parseCardIdFromIssueBody(undefined), null);
  assert.equal(lib.parseSourceFileFromIssueBody("<!-- SYNC_METADATA -->\n\nlower: x\nCARD_ID:  \n<!-- /SYNC_METADATA -->"), null);
  const a = { number: 3, state: "OPEN" };
  assert.equal(lib.pickCanonicalIssueForCardId(null, a), a);
  assert.equal(lib.pickCanonicalIssueForCardId(a, null), a);
  assert.equal(lib.pickCanonicalIssueForCardId(a, { number: 1, state: "closed" }), a);
  assert.equal(lib.pickCanonicalIssueForCardId({ number: "x" }, { number: 7 }).number, 7);
});

test("resolveSourceFileCandidates normalizes paths and handles empty input", () => {
  assert.deepEqual(lib.resolveSourceFileCandidates(""), []);
  assert.deepEqual(lib.resolveSourceFileCandidates(".\\cards\\X.md"), ["cards/X.md"]);
  assert.deepEqual(lib.resolveSourceFileCandidates("Kit/", { kitRootRel: "Kit/" }), ["Kit/"]);
});

test("readLocalCardFromSourceFile tries each candidate, null when none exist", async () => {
  const root = makeTempDir("hyperion-lib-source-");
  writeFile(root, "Hyperion/.github/cards/epics/E.md", "epic");
  const found = await lib.readLocalCardFromSourceFile(".github/cards/epics/E.md", { workspaceRoot: root, kitRootRel: "Hyperion" });
  assert.equal(found.relativeFile, "Hyperion/.github/cards/epics/E.md");
  assert.equal(found.content, "epic");
  assert.equal(await lib.readLocalCardFromSourceFile("missing.md", { workspaceRoot: root }), null);
});

test("readJsonIfExists parses JSON and returns null on missing/invalid", async () => {
  const root = makeTempDir("hyperion-lib-json-");
  assert.deepEqual(await lib.readJsonIfExists(writeFile(root, "a.json", '{"a":1}')), { a: 1 });
  assert.equal(await lib.readJsonIfExists(writeFile(root, "b.json", "{oops")), null);
});

test("assertCiProjectConfigured: off by default, ok with a projectNumber", async () => {
  const root = makeTempDir("hyperion-lib-ci-");
  const configPath = writeFile(root, "projects-map.json", JSON.stringify({ repositories: { "acme/app": { projectNumber: 12, projectOwner: "acme" } } }));
  await withEnv({ CARDS_CI_REQUIRE_PROJECT: undefined }, async () => {
    assert.deepEqual(await lib.assertCiProjectConfigured(configPath, "acme/app"), { ok: true, skipped: true });
  });
  await withEnv({ CARDS_CI_REQUIRE_PROJECT: "TRUE" }, async () => {
    assert.deepEqual(await lib.assertCiProjectConfigured(configPath, "acme/app", { backend: null }), { ok: true, projectNumber: 12, projectOwner: "acme" });
    assert.deepEqual(await lib.assertCiProjectConfigured(configPath, "other/repo"), {
      ok: false,
      reason: "missing_project_number",
      message: "CI pull-before-push requires projectNumber in projects-map.json. Run: npm run cards:doctor",
    });
  });
  const noOwner = writeFile(root, "p2.json", JSON.stringify({ default: { projectNumber: 1 } }));
  await withEnv({ CARDS_CI_REQUIRE_PROJECT: "true" }, async () => {
    assert.equal((await lib.assertCiProjectConfigured(noOwner, "acme/app")).projectOwner, null);
  });
});

test("readSyncBackendHint: project.yml backend, then projects-map, then github", async () => {
  const root = makeTempDir("hyperion-lib-backend-");
  const yml = (text) => writeFile(root, "project.yml", text);
  const map = (obj) => writeFile(root, "projects-map.json", JSON.stringify(obj));
  await withEnv({ CARDS_SYNC_BACKEND: undefined }, async () => {
    assert.equal(await lib.readSyncBackendHint({ projectYmlPath: yml("management:\n  backend: \"Jira\"\n") }), "jira");
    assert.equal(await lib.readSyncBackendHint({ projectYmlPath: yml("backend: 'gitlab'\n") }), "gitlab");
    const noBackendYml = yml("name: x\n");
    assert.equal(
      await lib.readSyncBackendHint({ projectYmlPath: noBackendYml, projectsMapPath: map({ default: { backend: "Azure" } }), repositorySlug: "acme/app" }),
      "azure"
    );
    assert.equal(
      await lib.readSyncBackendHint({
        projectYmlPath: join(root, "missing.yml"),
        projectsMapPath: map({ repositories: { "acme/app": { management: { backend: "LINEAR" } } } }),
        repositorySlug: "acme/app",
      }),
      "linear"
    );
    assert.equal(await lib.readSyncBackendHint({ projectsMapPath: join(root, "missing.json"), repositorySlug: "acme/app" }), "github");
    assert.equal(await lib.readSyncBackendHint(), "github");
  });
});

// ---------------------------------------------------------------------------
// Sync history / summary
// ---------------------------------------------------------------------------

test("writeSyncSummary writes last-sync.md and appends a forward-sync history event", async () => {
  const root = makeTempDir("hyperion-lib-summary-");
  const outPath = await lib.writeSyncSummary({
    workspaceRoot: root,
    repositorySlug: "acme/app",
    projectOwner: "acme",
    projectNumber: 4,
    actions: [
      { cardId: "S-1", action: "CREATE", url: "https://x/1" },
      { parent: "E-1", action: "LINK", number: 7 },
      { reason: "unchanged" },
      { cardId: "S-2", action: "MOVE", transition: "Done" },
      { cardId: "S-3", action: "NOOP" },
    ],
    cardCount: 5,
    incrementalIds: ["S-1"],
  });
  assert.equal(outPath, join(root, ".github", "plans", "cards", "last-sync.md"));
  const md = readFileSync(outPath, "utf8");
  assert.match(md, /- \*\*Project:\*\* acme#4/);
  assert.match(md, /- \*\*Incremental:\*\* S-1/);
  assert.match(md, /\| S-1 \| CREATE \| https:\/\/x\/1 \|/);
  assert.match(md, /\| E-1 \| LINK \| 7 \|/);
  assert.match(md, /\| — \| UNKNOWN \| unchanged \|/);
  assert.match(md, /\| S-2 \| MOVE \| Done \|/);
  assert.match(md, /\| S-3 \| NOOP \|  \|/);
  const [event] = readFileSync(join(root, ".github", "plans", "cards", "sync-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(event.type, "forward-sync");
  assert.equal(event.project, "acme#4");
  assert.deepEqual(event.incrementalIds, ["S-1"]);
  assert.equal(event.actionCount, 5);
});

test("writeSyncSummary with no actions/project; history failure is best-effort", async () => {
  const root = makeTempDir("hyperion-lib-summary2-");
  const plans = join(root, "plans");
  mkdirSync(join(plans, "sync-history.jsonl"), { recursive: true }); // appendFile → EISDIR
  const outPath = await lib.writeSyncSummary({ workspaceRoot: root, plansCardsDir: plans, repositorySlug: "acme/app", actions: [], cardCount: 0 });
  const md = readFileSync(outPath, "utf8");
  assert.doesNotMatch(md, /Project:|Incremental:/);
  assert.match(md, /\| — \| — \| No actions recorded \|/);
});

test("appendSyncEvent defaults the plans dir, repository and ok", async () => {
  const root = makeTempDir("hyperion-lib-append-");
  const historyPath = await lib.appendSyncEvent({ workspaceRoot: root, type: "x" });
  const row = JSON.parse(readFileSync(historyPath, "utf8"));
  assert.equal(row.repository, null);
  assert.equal(row.ok, true);
  assert.equal(historyPath, join(root, ".github", "plans", "cards", "sync-history.jsonl"));
});

// ---------------------------------------------------------------------------
// Labels / status columns catalogs
// ---------------------------------------------------------------------------

test("label helpers reject invalid entries and colors", () => {
  assert.equal(lib.normalizeLabelColor(""), null);
  assert.equal(lib.normalizeLabelColor("#xyz"), null);
  assert.equal(lib.normalizeLabelColor("#ABCDEF"), "abcdef");
  assert.equal(lib.normalizeLabelEntry("  "), null);
  assert.equal(lib.normalizeLabelEntry({ name: " " }), null);
  assert.equal(lib.normalizeLabelEntry(42), null);
  assert.deepEqual(lib.normalizeLabelEntry({ name: "X", color: "bad", description: 5 }), { name: "X", color: lib.colorFromString("X"), description: "" });
  assert.deepEqual(lib.parseLabelsCatalogJson("nope"), []);
  assert.deepEqual(lib.parseLabelsCatalogJson(["A", "A", null]).map((s) => s.name), ["A"]);
});

test("detectProjectLocaleFromYml reads locale, null when absent/missing", async () => {
  const root = makeTempDir("hyperion-lib-locale-");
  assert.equal(await lib.detectProjectLocaleFromYml(writeFile(root, "a.yml", "name: x\nlocale: pt-BR\n")), "pt-BR");
  assert.equal(await lib.detectProjectLocaleFromYml(writeFile(root, "b.yml", "name: x\n")), null);
  assert.equal(await lib.detectProjectLocaleFromYml(join(root, "missing.yml")), null);
});

test("loadLabelsCatalog: inline labels, no file, missing file, locale fallback, absolute path", async () => {
  const root = makeTempDir("hyperion-lib-labels-");
  const cardsRoot = join(root, "cards");
  writeFile(cardsRoot, "config/labels.custom.json", JSON.stringify(["Custom"]));

  const inline = await lib.loadLabelsCatalog({ cardsRoot, repoConfig: { labels: ["Bug", { name: "Custom", color: "000000" }] } });
  assert.equal(inline.file, "(inline config)");
  assert.deepEqual(inline.names, ["Bug", "Custom"]);
  assert.equal(inline.locale, "en");

  const none = await lib.loadLabelsCatalog({ cardsRoot, repoConfig: {}, projectLocale: "fr" });
  assert.deepEqual(none, { locale: "fr", specs: none.specs, names: ["Custom"], file: null, overlayFile: join(cardsRoot, "config", "labels.custom.json") });

  const missing = await lib.loadLabelsCatalog({ cardsRoot, repoConfig: { labelsFile: "labels.json" } });
  assert.equal(missing.file, join(cardsRoot, "config", "labels.json"));
  assert.deepEqual(missing.names, ["Custom"]);

  writeFile(cardsRoot, "config/labels.pt-BR.json", JSON.stringify(["Erro"]));
  const fallback = await lib.loadLabelsCatalog({ cardsRoot, repoConfig: { labelsFile: "labels.{locale}.json", locale: "pt-PT" } });
  assert.equal(fallback.file, join(cardsRoot, "config", "labels.pt-BR.json"));
  assert.deepEqual(fallback.names, ["Erro", "Custom"]);

  const abs = writeFile(root, "abs-labels.json", JSON.stringify(["Abs"]));
  assert.equal(lib.resolveLabelsCatalogFilePath(cardsRoot, { labelsFile: abs }, "en"), abs);
  assert.equal(lib.resolveLabelsCatalogFilePath(cardsRoot, { labels: [] }, "en"), null);
  assert.equal(lib.labelNamesFromCatalog((await lib.loadLabelsCatalog({ cardsRoot: join(root, "none"), repoConfig: { labelsFile: abs } })).specs)[0], "Abs");
});

test("loadStatusColumnsCatalog falls back to default columns; status helpers", async () => {
  const root = makeTempDir("hyperion-lib-status-");
  const fallback = await lib.loadStatusColumnsCatalog({ cardsRoot: root, repoConfig: {} });
  assert.equal(fallback.file, "(fallback)");
  assert.deepEqual(fallback.keys, lib.DEFAULT_STATUS_COLUMN_KEYS);
  assert.equal(fallback.specs[6].color, "GREEN");
  assert.equal(fallback.overlayFile, null);

  const abs = writeFile(root, "cols.json", JSON.stringify("not an array"));
  const empty = await lib.loadStatusColumnsCatalog({ cardsRoot: root, repoConfig: { statusColumnsFile: abs } });
  assert.equal(empty.file, abs);
  assert.equal(empty.keys.length, 7, "unparseable catalog → default columns");

  assert.equal(lib.normalizeProjectSelectColor(""), "GRAY");
  assert.equal(lib.normalizeStatusColumnEntry(null), null);
  assert.equal(lib.normalizeStatusColumnEntry({ name: " " }), null);
  assert.deepEqual(lib.normalizeStatusColumnEntry({ name: "Doing", description: 1 }), { key: "Doing", color: "GRAY", description: "" });
  assert.deepEqual(lib.parseStatusColumnsCatalogJson({}), []);
  assert.deepEqual(lib.parseStatusColumnsCatalogJson([{ key: "A" }, { key: "A" }, null]).length, 1);
  assert.deepEqual(lib.resolveStatusColumnSpecs({}, [{ key: "A", color: "RED", description: "" }])[0].name, "A");
  assert.equal(lib.DEFAULT_STATUS_OPTIONS, lib.DEFAULT_STATUS_COLUMN_KEYS);
});

// ---------------------------------------------------------------------------
// Frontmatter / card parsing
// ---------------------------------------------------------------------------

const FULL_CARD = [
  "---",
  "card_id: S-1",
  "title: \"Hello\"",
  "status: In Progress",
  "type: Bug",
  "priority: High",
  "sprint: null",
  "story_points: 5",
  "reporter: ana",
  "parent: F-1",
  "due_date: 2026-01-02",
  "board_sync_at: 2026-01-01T00:00:00.000Z",
  "categories:",
  "  - Backend",
  "  - \"API\"",
  "  - ''",
  "tags: [a, \"b\", ]",
  "Not_a_key: ignored",
  "empty_list:",
  "---",
  "",
  "# Heading",
  "",
  "## Sub-issues",
  "- [T-1 (#12)] first",
  "* T-2 second",
  "- [T-1] dup",
  "not a bullet",
  "## Notes",
  "- X-9 outside the section",
  "",
].join("\n");

test("parseFrontmatter handles lists, inline arrays, null, numbers and trailing lists", () => {
  const { meta, body } = lib.parseFrontmatter(FULL_CARD);
  assert.equal(meta.card_id, "S-1");
  assert.equal(meta.sprint, null);
  assert.equal(meta.story_points, 5);
  assert.deepEqual(meta.categories, ["Backend", "API"]);
  assert.deepEqual(meta.tags, ["a", "b"]);
  assert.deepEqual(meta.empty_list, []);
  assert.equal(meta.Not_a_key, undefined);
  assert.match(body, /^\n# Heading/);
  assert.equal(lib.parseFrontmatter("no frontmatter"), null);
});

test("parseCardFile maps frontmatter to a card; null without card_id", () => {
  const c = lib.parseCardFile(FULL_CARD, ".github/cards/tasks/F-1/S-1.md");
  assert.deepEqual(
    { ...c, body: undefined },
    {
      cardId: "S-1",
      title: "Hello",
      status: "In Progress",
      type: "Bug",
      priority: "High",
      sprint: null,
      storyPoints: 5,
      reporter: "ana",
      parent: "F-1",
      dueDate: "2026-01-02",
      boardSyncAt: "2026-01-01T00:00:00.000Z",
      categories: ["Backend", "API"],
      body: undefined,
      relativeFile: ".github/cards/tasks/F-1/S-1.md",
    }
  );
  const minimal = lib.parseCardFile("---\ncard_id: M-1\n---\n\n# From body\n", "m.md");
  assert.equal(minimal.title, "From body");
  assert.equal(minimal.type, "Story");
  assert.deepEqual(minimal.categories, []);
  assert.equal(lib.parseCardFile("---\ncard_id: N-1\n---\n\nno heading\n", "n.md").title, "Untitled");
  assert.equal(lib.parseCardFile("---\ntitle: x\n---\n\n", "x.md"), null);
  assert.equal(lib.parseCardFile("plain", "x.md"), null);
});

test("sub-issue parsing, reference extraction and edge building", () => {
  assert.deepEqual(lib.splitBodyLines("a\r\nb\rc"), ["a", "b", "c"]);
  assert.deepEqual(lib.splitBodyLines(undefined), [""]);
  assert.equal(lib.extractCardIdFromReference("[T-1 (#3)] x"), "T-1");
  assert.equal(lib.extractCardIdFromReference("T-2 rest"), "T-2");
  assert.equal(lib.extractCardIdFromReference("  ~weird"), "~weird");
  assert.deepEqual(lib.parseSubIssueIds(lib.parseFrontmatter(FULL_CARD).body), ["T-1", "T-2", "T-1"]);
  assert.deepEqual(lib.parseSubIssueIds("- T-1"), []);

  const cards = [
    { cardId: "E-1", parent: null, body: "## Sub-issues\n- F-1\n- MISSING-1\n- E-1" },
    { cardId: "F-1", parent: "E-1", body: "" },
    { cardId: "S-1", parent: "GONE", body: undefined },
  ];
  assert.deepEqual(lib.buildEdges(cards), [{ parentCardId: "E-1", childCardId: "F-1" }]);
});

test("issue title / remote description formatting", () => {
  assert.equal(lib.buildIssueTitle({ cardId: "S-1", title: "[Old] Hello" }), "[Story] Hello");
  assert.equal(lib.buildIssueTitle({ cardId: "S-1", type: "Bug", title: "" }), "[Bug] S-1");
  const card = lib.parseCardFile(FULL_CARD, ".github/cards/tasks/F-1/S-1.md");
  const desc = lib.buildRemoteDescriptionFromCard(card);
  assert.match(desc, /CARD_ID: S-1\nSOURCE_FILE: \.github\/cards\/tasks\/F-1\/S-1\.md\nTYPE: Bug/);
  assert.match(desc, /CATEGORIES: Backend, API\nBOARD_SYNC_AT: 2026-01-01T00:00:00\.000Z\n<!-- \/SYNC_METADATA -->$/);
  const bare = lib.buildJiraDescription({ cardId: "B-1", relativeFile: "b.md", body: "  body  " });
  assert.match(bare, /^body\n\n---\n/);
  assert.match(bare, /TYPE: Story\nSTATUS: \nPRIORITY: \nSPRINT: \nSTORY_POINTS: \nREPORTER: \nPARENT_CARD_ID: \nDUE_DATE: \nCATEGORIES: \n<!--/);
  assert.equal(lib.parseCardIdFromRemoteDescription(desc), "S-1");
});

test("option mapping: direct/locale maps, canonicalization via maps and aliases, candidates", () => {
  const repoConfig = {
    locale: "pt-BR",
    optionMap: { priority: { High: "P1" } },
    optionMapByLocale: { "pt-BR": { status: { Done: "Concluído" } } },
  };
  assert.equal(lib.normalizeText("  Concluído "), "concluido");
  assert.equal(lib.normalizeText(null), "");
  assert.equal(lib.resolveMappedOptionValue("status", "Done", repoConfig), "Concluído");
  assert.equal(lib.resolveMappedOptionValue("priority", "High", repoConfig), "P1");
  assert.equal(lib.resolveMappedOptionValue("priority", "Low", undefined), "Low");
  assert.equal(lib.resolveMappedOptionValue("", "x", repoConfig), "x");
  assert.equal(lib.resolveMappedOptionValue("status", null, repoConfig), null);

  assert.equal(lib.canonicalizeRemoteOption("status", null, repoConfig), null);
  assert.equal(lib.canonicalizeRemoteOption("status", "  ", repoConfig), null);
  assert.equal(lib.canonicalizeRemoteOption("status", "concluido", repoConfig), "Done");
  assert.equal(lib.canonicalizeRemoteOption("status", "done", repoConfig), "Done");
  assert.equal(lib.canonicalizeRemoteOption("priority", "p1", repoConfig), "High");
  assert.equal(lib.canonicalizeRemoteOption("priority", "high", repoConfig), "High");
  assert.equal(lib.canonicalizeRemoteOption("type", "Épico", {}), "Epic");
  assert.equal(lib.canonicalizeRemoteOption("type", "story", {}), "Story");
  assert.equal(lib.canonicalizeRemoteOption("unknown_field", "Raw", {}), "Raw");

  assert.deepEqual(lib.buildOptionCandidates("status", "Done", repoConfig), ["Concluído", "Done", "feito"]);
  assert.deepEqual(lib.buildOptionCandidates("priority", "urgent", {}), ["urgent", "Highest", "critical", "critico", "urgente"]);
  assert.deepEqual(lib.buildOptionCandidates("sprint", "", {}), []);

  assert.equal(lib.resolveMappedStatus({ Done: "Closed" }, "Done"), "Closed");
  assert.equal(lib.resolveMappedStatus(null, "Doing"), "Doing");
  assert.equal(lib.resolveMappedStatus({}, ""), null);
});

test("reverse helpers: description parsing, summary titles, yaml quoting", () => {
  assert.equal(lib.parseSyncMetadataFromDescription("plain"), null);
  const parsed = lib.parseSyncMetadataFromDescription("Body\n\n---\n<!-- SYNC_METADATA -->\nCARD_ID: X\n\nnot meta\n<!-- /SYNC_METADATA -->");
  assert.deepEqual(parsed, { meta: { CARD_ID: "X" }, bodyContent: "Body" });
  assert.deepEqual(lib.parseIssueSummaryTypeTitle("[Bug]  Crash"), { type: "Bug", title: "Crash" });
  assert.deepEqual(lib.parseIssueSummaryTypeTitle(""), { type: "Story", title: "Untitled" });
  assert.equal(lib.yamlQuote('a "b" \\c'), '"a \\"b\\" \\\\c"');
  assert.equal(lib.yamlQuote(undefined), '""');
  assert.equal(lib.yamlNullIfEmpty("  "), "null");
  assert.equal(lib.yamlNullIfEmptyNumber(""), "null");
  assert.equal(lib.yamlNullIfEmptyNumber("abc"), "null");
  assert.equal(lib.yamlNullIfEmptyNumber(" 8 "), "8");
});

test("remoteIssueToCardMarkdown builds a card, honoring labels and status override", () => {
  const desc = lib.buildRemoteDescriptionFromCard(lib.parseCardFile(FULL_CARD, ".github/cards/tasks/F-1/S-1.md"));
  const fromMeta = lib.remoteIssueToCardMarkdown({ title: "[Bug] Hello", description: desc });
  assert.equal(fromMeta.sourceFile, ".github/cards/tasks/F-1/S-1.md");
  assert.match(fromMeta.markdown, /card_id: "S-1"\ntitle: "Hello"\nstatus: "In Progress"\ntype: "Bug"\npriority: "High"\nsprint: null\nstory_points: 5\nreporter: "ana"\nparent: "F-1"\ndue_date: "2026-01-02"\ncategories:\n  - "Backend"\n  - "API"\n---/);

  const overridden = lib.remoteIssueToCardMarkdown({ title: "Plain", description: desc, labels: ["L1"], statusOverride: "Done" });
  assert.match(overridden.markdown, /title: "Plain"\nstatus: "Done"\ntype: "Bug"/);
  assert.match(overridden.markdown, /categories:\n  - "L1"/);

  const noCats = lib.remoteIssueToCardMarkdown({
    title: "[Task] T",
    description: "b\n---\n<!-- SYNC_METADATA -->\nCARD_ID: T-1\nSOURCE_FILE: t.md\n<!-- /SYNC_METADATA -->",
    labels: [],
    statusOverride: " ",
  });
  assert.match(noCats.markdown, /status: null\ntype: "Task"/);
  assert.match(noCats.markdown, /categories: \[\]/);

  assert.equal(lib.remoteIssueToCardMarkdown({ title: "x", description: "none" }), null);
  assert.equal(lib.remoteIssueToCardMarkdown({ title: "x", description: "<!-- SYNC_METADATA -->\nCARD_ID: X\n<!-- /SYNC_METADATA -->" }), null);
  assert.equal(
    lib.remoteIssueToCardMarkdown({ title: "x", description: "<!-- SYNC_METADATA -->\nCARD_ID: EXAMPLE-1\nSOURCE_FILE: e.md\n<!-- /SYNC_METADATA -->" }),
    null,
    "kit samples never reverse-sync"
  );
});

test("buildCardMarkdownFromMeta / patchCardFrontmatter / frontmatterDiffers", () => {
  const md = lib.buildCardMarkdownFromMeta({ card_id: "A", title: "T", categories: ["x"] }, undefined);
  assert.match(md, /type: "Story"/);
  assert.match(md, /categories:\n  - "x"\n---\n\n\n$/);
  assert.equal(lib.patchCardFrontmatter("no frontmatter", {}), null);
  const patched = lib.patchCardFrontmatter("---\ncard_id: A\n---\n\n# Body title\n", {});
  assert.match(patched, /title: "Body title"/);
  assert.match(patched, /categories: \[\]/);
  const all = lib.patchCardFrontmatter(FULL_CARD, {
    status: "Done",
    type: "Task",
    priority: "Low",
    sprint: "S9",
    story_points: 1,
    reporter: "bo",
    parent: "F-2",
    due_date: "2026-02-02",
    categories: [],
    board_sync_at: "2026-03-03T00:00:00.000Z",
  });
  assert.match(all, /status: "Done"\ntype: "Task"\npriority: "Low"\nsprint: "S9"\nstory_points: 1\nreporter: "bo"\nparent: "F-2"\ndue_date: "2026-02-02"\nboard_sync_at: "2026-03-03T00:00:00\.000Z"\ncategories: \[\]/);

  assert.equal(lib.frontmatterDiffers("plain", {}), true);
  assert.equal(lib.frontmatterDiffers(FULL_CARD, { categories: ["Backend", "API"] }), false);
  assert.equal(lib.frontmatterDiffers(FULL_CARD, { categories: ["API"] }), true);
  assert.equal(lib.frontmatterDiffers(FULL_CARD, { story_points: "5" }), false);
  assert.equal(lib.frontmatterDiffers(FULL_CARD, { sprint: null }), false);
  assert.equal(lib.frontmatterDiffers(FULL_CARD, { board_sync_at: "2026-09-09" }), true);
});

test("remoteBoardSyncAt / status inversion / converted-markdown updates", () => {
  assert.equal(lib.remoteBoardSyncAt({ updatedAt: "2026-01-01T00:00:00Z" }), "2026-01-01T00:00:00.000Z");
  assert.equal(lib.remoteBoardSyncAt({ updated_at: "2026-01-02T00:00:00Z" }), "2026-01-02T00:00:00.000Z");
  assert.equal(lib.remoteBoardSyncAt({ fields: { updated: "2026-01-03T00:00:00Z" } }), "2026-01-03T00:00:00.000Z");
  assert.equal(lib.remoteBoardSyncAt({ fields: { "System.ChangedDate": " garbage " } }), "garbage");
  assert.equal(lib.remoteBoardSyncAt(null), null);

  assert.deepEqual(lib.inverseStatusMap({ Done: "Closed", Backlog: "" }), { Closed: "Done" });
  assert.deepEqual(lib.inverseStatusMap(undefined), {});
  const statusMap = { "In Progress": "Doing" };
  assert.equal(lib.resolveHyperionStatusFromRemote(null, statusMap), null);
  assert.equal(lib.resolveHyperionStatusFromRemote("Doing", statusMap), "In Progress");
  assert.equal(lib.resolveHyperionStatusFromRemote(" doing", statusMap), "In Progress");
  assert.equal(lib.resolveHyperionStatusFromRemote("em testes", statusMap, {}), "In tests");
  assert.equal(lib.canonicalizeLinearState("Doing", statusMap, {}), "In Progress");

  assert.deepEqual(lib.frontmatterUpdatesFromConvertedMarkdown(null), {});
  assert.deepEqual(lib.frontmatterUpdatesFromConvertedMarkdown({ markdown: "plain" }), {});
  const converted = lib.remoteIssueToCardMarkdown({
    title: "[Task] T",
    description: "<!-- SYNC_METADATA -->\nCARD_ID: T-1\nSOURCE_FILE: t.md\nSTATUS: Done\nSTORY_POINTS: 2\n<!-- /SYNC_METADATA -->",
  });
  assert.deepEqual(lib.frontmatterUpdatesFromConvertedMarkdown(converted), {
    status: "Done",
    type: "Task",
    priority: undefined,
    sprint: undefined,
    story_points: 2,
    reporter: undefined,
    parent: undefined,
    due_date: undefined,
    categories: [],
    board_sync_at: undefined,
  });
});
