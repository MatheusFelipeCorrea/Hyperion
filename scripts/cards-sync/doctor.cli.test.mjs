import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { HEALTHY_PROJECT_FIELDS, createWorkspace, runCli } from "./fixtures/cards-cli-harness.mjs";

const CONFIG_PATH = ".github/cards/config/projects-map.json";
const FIELD_MAP = {
  status: "Status",
  type: "Type",
  priority: "Priority",
  sprint: "Sprint",
  storyPoints: "Story Points",
  reporter: "Reporter",
  parent: "Parent (Epic/Feature)",
  dueDate: "Due Date",
};
const GITHUB_CONFIG = {
  default: {
    projectNumber: 3,
    projectOwner: "acme",
    fieldMap: FIELD_MAP,
    optionMapByLocale: { en: { status: { Backlog: "Backlog" }, type: { Story: "Story" }, priority: { High: "High" } } },
    labelsFile: "labels.{locale}.json",
    statusColumnsFile: "status-columns.{locale}.json",
  },
};
const field = (name, extra = {}) => ({ ...HEALTHY_PROJECT_FIELDS.find((f) => f.name === name), ...extra });
const fieldsWith = (overrides) => HEALTHY_PROJECT_FIELDS.map((f) => (f.name in overrides ? overrides[f.name] : f)).filter(Boolean);
const graphqlCalls = (run) => run.calls.filter((c) => c.url === "https://api.github.com/graphql");
// Doctor runs the kit's real sync.mjs (the workspaces have no scripts/ of their own), unattended
// (CARDS_SYNC_YES) and with fetch mocked in grandchildren (`chain`); with no cards it stops early.
const SYNC_ENV = { CARDS_SYNC_YES: "true" };
const SYNC_RAN = /\[cards-sync\] No card files found/;

function withWorkspace(opts, fn) {
  const ws = createWorkspace(opts);
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// GitHub — Project found
// ---------------------------------------------------------------------------

test("doctor: healthy GitHub setup passes every check (exit 0) and flags stale community MCP packages", () =>
  withWorkspace(
    {
      config: GITHUB_CONFIG,
      projectYml: "project:\n  name: app\n",
      files: {
        ".github/cards/config/labels.en.json": [],
        ".github/cards/config/labels.custom.json": [],
        ".github/cards/config/status-columns.en.json": [],
        ".github/cards/config/status-columns.custom.json": [],
        ".cursor/mcp.json": {
          mcpServers: {
            linear: { command: "npx", args: ["-y", "mcp-linear"] },
            atlassian: { command: "npx", args: ["-y", "mcp-atlassian"] },
            gitlab: { command: "npx", args: ["mcp-gitlab"] },
            azure: { command: "npx", args: ["-y", "@azure-devops/mcp"] },
            local: { command: "node", args: ["server.js"] },
            broken: null,
          },
        },
      },
    },
    (ws) => {
      const run = runCli("doctor.mjs", [], {
        ws,
        npmModified: { "mcp-linear": "2020-01-01T00:00:00Z", "mcp-atlassian": new Date().toISOString() },
        state: { github: { project: { scope: "repository", fields: HEALTHY_PROJECT_FIELDS } } },
      });
      assert.equal(run.status, 0, run.out);
      for (const line of [
        "✅ Repo: acme/app",
        "✅ Token source: PROJECT_SYNC_TOKEN",
        "✅ Backend detected: github",
        "✅ Found .github/project.yml",
        '✅ optionMapByLocale found for locale "en".',
        "✅ labelsFile OK: ",
        "✅ labels overlay OK: ",
        "✅ statusColumnsFile OK: ",
        "✅ status columns overlay OK: ",
        'info Resolved project: owner="acme", number=3',
        "✅ All required Project fields exist.",
        "✅ Status field options match Hyperion flow (7 columns).",
        "✅ Sprint iteration field OK: Sprint (1 iteration(s)).",
        "✅ Doctor finished.",
      ]) {
        assert.ok(run.stdout.includes(`[doctor] ${line}`), `missing "${line}" in:\n${run.stdout}`);
      }
      assert.match(run.stdout, /MCP package "mcp-linear" \(configured in \.cursor\/mcp\.json\) hasn't published in ~\d+ months/);
      assert.doesNotMatch(run.stdout, /MCP package "mcp-(atlassian|gitlab)"/);
      assert.deepEqual(
        run.tools.filter((t) => t.tool === "npm").map((t) => t.args[1]).sort(),
        ["mcp-atlassian", "mcp-gitlab", "mcp-linear"],
        "only community packages are looked up"
      );
      const [lookup] = graphqlCalls(run);
      assert.equal(lookup.headers.Authorization, "Bearer test-token");
      assert.deepEqual(lookup.body.variables, { owner: "acme", name: "app", number: 3 });
      assert.equal(graphqlCalls(run).length, 1);
    }
  ));

test("doctor: org-level Project with a non-select Status and no Sprint; bare config → warnings + exit 1", () =>
  withWorkspace({ config: { default: { projectNumber: 3 } } }, (ws) => {
    const run = runCli("doctor.mjs", [], {
      ws,
      env: { PROJECT_SYNC_TOKEN: undefined, GITHUB_TOKEN: "actions-token" },
      state: {
        github: {
          project: { scope: "organization", fields: fieldsWith({ Status: { __typename: "ProjectV2Field", id: "F", name: "Status" }, Sprint: null }) },
        },
      },
    });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /Token source: GITHUB_TOKEN/);
    assert.match(run.stdout, /Missing \.github\/project\.yml\./);
    assert.match(run.stdout, /projects-map\.json\.fieldMap is missing\/empty/);
    assert.match(run.stdout, /optionMapByLocale incomplete for locale "en"/);
    assert.match(run.stdout, /labelsFile missing/);
    assert.match(run.stdout, /statusColumnsFile missing/);
    assert.match(run.stdout, /Missing required Project fields: Sprint/);
    assert.match(run.stdout, /cards:project-fields-apply -- --yes/);
    assert.ok(run.stdout.includes("3) Or set projects-map.json default.projectNumber=0 and let sync auto-create"), run.stdout);
    assert.match(run.stdout, /Status field was not found as a single-select field\./);
    assert.match(run.stdout, /Sprint iteration field not found \(expected: Sprint\)\./);
    assert.deepEqual(
      graphqlCalls(run).map((c) => c.body.query.match(/(repository|user|organization)\(/)[1]),
      ["repository", "user", "organization"]
    );
    assert.equal(graphqlCalls(run)[0].headers.Authorization, "Bearer actions-token");
  }));

test("doctor: user-level Project, PROJECT_OWNER/NUMBER env, localized Status mapping and wrong Sprint type → exit 1", () =>
  withWorkspace(
    {
      config: {
        default: {
          projectNumber: 3,
          locale: "pt-BR",
          fieldMap: FIELD_MAP,
          optionMapByLocale: { "pt-BR": { status: { Backlog: "A Fazer", "Functional Refinement": "Refinamento Funcional" }, type: {}, priority: {} } },
          statusColumnsFile: "status-columns.json",
        },
      },
    },
    (ws) => {
      const labelsAbs = ws.path("elsewhere/labels.json");
      ws.write(CONFIG_PATH, { default: { ...ws.readJson(CONFIG_PATH).default, labelsFile: labelsAbs } });
      const run = runCli("doctor.mjs", [], {
        ws,
        env: { PROJECT_OWNER: "octo", PROJECT_NUMBER: "8" },
        state: {
          github: {
            project: {
              scope: "user",
              fields: fieldsWith({
                Status: field("Status", { options: [{ id: "a", name: "A Fazer" }, { id: "d", name: "Done" }] }),
                Sprint: { __typename: "ProjectV2Field", id: "F_s", name: "Sprint", dataType: "TEXT" },
              }),
            },
          },
        },
      });
      assert.equal(run.status, 1, run.out);
      assert.match(run.stdout, /optionMapByLocale found for locale "pt-BR"/);
      assert.ok(run.stdout.includes(`labelsFile resolved path not found: ${labelsAbs}`), run.stdout);
      assert.match(run.stdout, /statusColumnsFile resolved path not found: .*status-columns\.json/);
      assert.match(run.stdout, /Resolved project: owner="octo", number=8/);
      assert.match(
        run.stdout,
        /Status field is missing Hyperion options: Refinamento Funcional \(Functional Refinement\), Technical Refinement, In Progress, In Tests, In Revision\./
      );
      assert.match(run.stdout, /Current Status options: A Fazer, Done/);
      assert.match(run.stdout, /Sprint field "Sprint" should be Iteration type, found ProjectV2Field\./);
      assert.match(run.stdout, /All required Project fields exist\./);
      assert.deepEqual(graphqlCalls(run)[1].body.variables, { owner: "octo", number: 8 });
    }
  ));

test("doctor: missing-fields advice names the projectNumber entry in effect (repositories entry, PROJECT_NUMBER env)", () =>
  withWorkspace({ config: { default: { projectNumber: 7 }, repositories: { "acme/app": { projectNumber: 3 } } } }, (ws) => {
    const state = { github: { project: { scope: "repository", fields: fieldsWith({ "Due Date": null }) } } };
    const fromEntry = runCli("doctor.mjs", [], { ws, state });
    assert.equal(fromEntry.status, 1, fromEntry.out);
    assert.match(fromEntry.stdout, /Missing required Project fields: Due Date/);
    assert.ok(fromEntry.stdout.includes('3) Or set projects-map.json repositories["acme/app"].projectNumber=0 and let sync'), fromEntry.stdout);

    const fromEnv = runCli("doctor.mjs", [], { ws, env: { PROJECT_NUMBER: "3" }, state });
    assert.equal(fromEnv.status, 1, fromEnv.out);
    assert.ok(
      fromEnv.stdout.includes('3) Or unset PROJECT_NUMBER, set projects-map.json repositories["acme/app"].projectNumber=0 and let sync'),
      fromEnv.stdout
    );
  }));

test("doctor: Status with no options and an empty Sprint iteration field → exit 1", () =>
  withWorkspace({ config: GITHUB_CONFIG }, (ws) => {
    const run = runCli("doctor.mjs", [], {
      ws,
      state: {
        github: {
          project: {
            scope: "repository",
            fields: fieldsWith({ Status: field("Status", { options: undefined }), Sprint: { __typename: "ProjectV2IterationField", id: "F_s", name: "Sprint" } }),
          },
        },
      },
    });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /Current Status options: \(none\)/);
    assert.match(run.stdout, /Sprint iteration field OK: Sprint \(0 iterations — add sprints in Project Settings when ready\)\./);
  }));

// ---------------------------------------------------------------------------
// GitHub — local-only / repo + token detection
// ---------------------------------------------------------------------------

test("doctor: missing projects-map.json → exit 1", () =>
  withWorkspace({}, (ws) => {
    const run = runCli("doctor.mjs", [], { ws, env: { GITHUB_REPOSITORY: undefined, FAKE_GIT_ORIGIN: "https://gitlab.com/acme/app.git" } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /❌ Could not read .*projects-map\.json\./);
    assert.match(run.stdout, /Run setup: `cards-sync-setup` skill/);
  }));

test("doctor: no token anywhere → local checks only (exit 0); repo from an https git remote", () =>
  withWorkspace({ config: { default: {} } }, (ws) => {
    const run = runCli("doctor.mjs", [], {
      ws,
      env: { PROJECT_SYNC_TOKEN: undefined, GITHUB_REPOSITORY: undefined, FAKE_GIT_ORIGIN: "https://github.com/octo/widgets.git" },
    });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Repo: octo\/widgets/);
    assert.match(run.stdout, /Token source: none — no PROJECT_SYNC_TOKEN, GITHUB_TOKEN, or `gh auth token` available\./);
    assert.match(run.stdout, /No GitHub token available\. Doctor will only do local checks\./);
    assert.equal(run.calls.length, 0);
  }));

test("doctor: gh-cli token + ssh remote; projectNumber unset with autoCreateProject=false → exit 0", () =>
  withWorkspace({ config: { default: { autoCreateProject: false } } }, (ws) => {
    const run = runCli("doctor.mjs", [], {
      ws,
      env: { PROJECT_SYNC_TOKEN: undefined, GITHUB_REPOSITORY: undefined, FAKE_GIT_ORIGIN: "git@github.com:octo/widgets.git", FAKE_GH_TOKEN: "gho_session" },
    });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Repo: octo\/widgets/);
    assert.match(run.stdout, /Token source: gh-cli — falling back to your local `gh auth token` session/);
    assert.match(run.stdout, /projectNumber not set \(or <=0\) and autoCreateProject is false/);
    assert.equal(run.calls.length, 0);
  }));

// ---------------------------------------------------------------------------
// GitHub — projectNumber unset (discovery + optional auto-create)
// ---------------------------------------------------------------------------

test("doctor: projectNumber unset but discoverable → preview only, config untouched (exit 0)", () =>
  withWorkspace({ config: { default: {} } }, (ws) => {
    const before = ws.read(CONFIG_PATH);
    const run = runCli("doctor.mjs", [], {
      ws,
      state: { github: { projects: { repository: [{ number: 9, title: "app Hyperion Project", id: "P9" }] } } },
    });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /sync\.mjs would auto-discover GitHub Project #9: "app Hyperion Project"/);
    assert.match(run.stdout, /Not yet saved to projects-map\.json/);
    assert.equal(ws.read(CONFIG_PATH), before);
  }));

test("doctor: projectNumber unset, nothing discovered, no TTY → never prompts, exit 0", () =>
  withWorkspace({ config: { default: {} } }, (ws) => {
    const run = runCli("doctor.mjs", [], { ws, state: { github: {} } });
    assert.equal(run.status, 0, run.out);
    assert.doesNotMatch(run.stdout, /\(y\/N\)/);
    assert.match(run.stdout, /Auto-create skipped\. Run `npm run cards:sync` when you're ready/);
    assert.equal(graphqlCalls(run).length, 3, "repository, user and organization project listings");
  }));

test("doctor: ambiguous projects + interactive 'n' → lists candidates, exit 0", () =>
  withWorkspace({ config: { default: {} } }, (ws) => {
    const run = runCli("doctor.mjs", [], {
      ws,
      tty: true,
      input: "n\n",
      state: { github: { projects: { repository: [{ number: 1, title: "Alpha" }, { number: 2, title: "Beta" }] } } },
    });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Project number missing\. Can I run sync\.mjs to auto-create the GitHub Project\? \(y\/N\): /);
    assert.match(run.stdout, /Multiple GitHub Projects found/);
    assert.match(run.stdout, /candidate: #1 Alpha/);
    assert.match(run.stdout, /candidate: #2 Beta/);
    assert.doesNotMatch(run.stdout, /\[cards-sync\]/);
  }));

test("doctor: projectNumber unset + interactive 'y' → runs the kit's sync.mjs and exits with its status", () =>
  withWorkspace({ config: { default: {} } }, (ws) => {
    const run = runCli("doctor.mjs", [], { ws, tty: true, chain: true, input: "y\n", env: SYNC_ENV, state: { github: {} } });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Running sync\.mjs \(real mode\) to auto-create project\/fields\/labels/);
    assert.match(run.stdout, SYNC_RAN);

    // GitHub answers 502: doctor's discovery shrugs it off, reverse sync's issue lookup fails (exit 1).
    const failing = runCli("doctor.mjs", [], {
      ws,
      tty: true,
      chain: true,
      input: "y\n",
      env: { ...SYNC_ENV, SYNC_DIRECTION: "reverse" },
      state: { responses: [{ url: "https://api.github.com/graphql", status: 502, body: { message: "upstream unavailable" } }] },
    });
    assert.equal(failing.status, 1, failing.out);
    assert.match(failing.stderr, /\[cards-sync\] FATAL ERROR/);
    assert.match(failing.stderr, /upstream unavailable/, "reverse sync's issue lookup hit the fetch mock");
  }));

// ---------------------------------------------------------------------------
// GitHub — projectNumber set but Project not found
// ---------------------------------------------------------------------------

test("doctor: Project not found with autoCreateProject=false → exit 0 without prompting", () =>
  withWorkspace({ config: { default: { projectNumber: 3, autoCreateProject: false } } }, (ws) => {
    const run = runCli("doctor.mjs", [], { ws, tty: true, input: "y\n", state: { github: {} } });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /GitHub Project not found for owner="acme" number=3\./);
    assert.match(run.stdout, /autoCreateProject is false in projects-map\.json/);
    assert.doesNotMatch(run.stdout, /\(y\/N\)/);
  }));

test("doctor: Project not found + --yes never prompts even on a TTY → exit 0, config untouched", () =>
  withWorkspace({ config: { default: { projectNumber: 3 } } }, (ws) => {
    const before = ws.read(CONFIG_PATH);
    const run = runCli("doctor.mjs", ["--yes"], { ws, tty: true, input: "y\n", state: { github: {} } });
    assert.equal(run.status, 0, run.out);
    assert.doesNotMatch(run.stdout, /\(y\/N\)/);
    assert.match(run.stdout, /Auto-create skipped\. You can set default\.projectNumber to 0 in projects-map\.json manually/);
    assert.equal(ws.read(CONFIG_PATH), before);
  }));

test("doctor: Project not found + interactive 'yes' → resets the repositories entry that set the number, then runs sync.mjs", () =>
  withWorkspace(
    {
      config: { default: { projectNumber: 7 }, repositories: { "acme/app": { projectNumber: 5 } } },
    },
    (ws) => {
      const run = runCli("doctor.mjs", [], { ws, tty: true, chain: true, input: "yes\n", env: SYNC_ENV, state: { github: {} } });
      assert.equal(run.status, 0, run.out);
      assert.match(run.stdout, /GitHub Project not found for owner="acme" number=5\./);
      assert.ok(run.stdout.includes('Can I set projects-map.json repositories["acme/app"].projectNumber to 0'), run.stdout);
      assert.ok(run.stdout.includes('projects-map.json updated: repositories["acme/app"].projectNumber=0'), run.stdout);
      const saved = ws.readJson(CONFIG_PATH);
      assert.equal(saved.repositories["acme/app"].projectNumber, 0);
      assert.equal(saved.default.projectNumber, 7, "the default isn't what pointed at the missing Project");
      assert.match(run.stdout, SYNC_RAN);
    }
  ));

test("doctor: Project not found via PROJECT_NUMBER env → explains the override, no prompt, no edit, no sync", () =>
  withWorkspace({ config: { default: { projectNumber: 3 } } }, (ws) => {
    const before = ws.read(CONFIG_PATH);
    const run = runCli("doctor.mjs", [], { ws, tty: true, chain: true, input: "y\n", env: { PROJECT_NUMBER: "8" }, state: { github: {} } });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /GitHub Project not found for owner="acme" number=8\./);
    assert.match(run.stdout, /PROJECT_NUMBER environment variable \(PROJECT_NUMBER=8\), which overrides projects-map\.json/);
    assert.match(run.stdout, /Remove PROJECT_NUMBER .* shell, \.env file or CI variables/);
    assert.doesNotMatch(run.stdout, /\(y\/N\)/);
    assert.equal(ws.read(CONFIG_PATH), before);
    assert.doesNotMatch(run.stdout, /\[cards-sync\]/);
  }));

test(
  "doctor: Project not found + 'y' but projects-map.json can't be written → exit 1",
  { skip: process.getuid?.() === 0 && "root ignores the read-only bit" },
  () =>
    withWorkspace({ config: { default: { projectNumber: 5 } } }, (ws) => {
      chmodSync(ws.path(CONFIG_PATH), 0o444);
      try {
        const run = runCli("doctor.mjs", [], { ws, tty: true, input: "y\n", state: { github: {} } });
        assert.equal(run.status, 1, run.out);
        assert.match(run.stdout, /❌ Could not edit projects-map\.json: /);
        assert.equal(ws.readJson(CONFIG_PATH).default.projectNumber, 5);
      } finally {
        chmodSync(ws.path(CONFIG_PATH), 0o644);
      }
    })
);

// ---------------------------------------------------------------------------
// Other backends
// ---------------------------------------------------------------------------

const JIRA_ENV = { JIRA_URL: "https://jira.example/", JIRA_PROJECT_KEY: "PROJ", JIRA_EMAIL: "bot@acme.test", JIRA_API_TOKEN: "jt" };

test("doctor (Jira): missing env → exit 1 and GitHub token noise is skipped", () =>
  withWorkspace({ config: { default: { backend: "jira" } } }, (ws) => {
    const run = runCli("doctor.mjs", [], { ws, env: { JIRA_URL: "https://jira.example" } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /Backend detected: jira/);
    assert.doesNotMatch(run.stdout, /Token source/);
    assert.match(run.stdout, /JIRA_URL, JIRA_PROJECT_KEY, JIRA_EMAIL, JIRA_API_TOKEN/);
  }));

test("doctor (Jira): project + issue-type checks pass (backend from project.yml) → exit 0", () =>
  withWorkspace({ config: { default: {} }, projectYml: "management:\n  backend: jira\n" }, (ws) => {
    const run = runCli("doctor.mjs", [], {
      ws,
      env: { ...JIRA_ENV, JIRA_ISSUE_TYPE: "Story" },
      state: { responses: [{ url: "/rest/api/2/project/PROJ", body: { key: "PROJ" } }, { url: "/rest/api/2/issue/createmeta", body: "" }] },
    });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Jira project OK: PROJ/);
    assert.match(run.stdout, /Jira issue type OK: Story/);
    assert.match(run.stdout, /Doctor finished \(Jira remote checks passed\)\./);
    assert.equal(run.calls[0].url, "https://jira.example/rest/api/2/project/PROJ");
    assert.equal(run.calls[0].headers.Authorization, `Basic ${Buffer.from("bot@acme.test:jt").toString("base64")}`);
    assert.match(run.calls[1].url, /createmeta\?projectKeys=PROJ&issuetypeNames=Story&expand=projects\.issuetypes\.fields$/);
  }));

test("doctor: project.yml backend with quotes, an inline comment and CRLF is still detected", () =>
  withWorkspace({ config: { default: {} }, projectYml: "management:\r\n  backend: \"Jira\"  # tracker\r\n" }, (ws) => {
    const run = runCli("doctor.mjs", [], { ws });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /Backend detected: jira/);
    assert.match(run.stdout, /Jira backend detected\. Missing one or more required env vars/);
  }));

test("doctor (Jira): a failing request aborts with exit 1", () =>
  withWorkspace({ config: { default: { backend: "jira" } } }, (ws) => {
    const run = runCli("doctor.mjs", [], {
      ws,
      env: JIRA_ENV,
      state: { responses: [{ url: "/rest/api/2/project/PROJ", status: 404, statusText: "Not Found", body: "<html>nope</html>" }] },
    });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stderr, /Jira request failed \(404 Not Found\)/);
    assert.equal(run.calls.length, 1);
  }));

test("doctor (Azure DevOps): env/config checks, project probe and status_map reporting", () =>
  withWorkspace({ config: { default: { backend: "azure-devops" } } }, (ws) => {
    const missing = runCli("doctor.mjs", [], { ws });
    assert.equal(missing.status, 1, missing.out);
    assert.match(missing.stdout, /AZDO_ORG_URL, AZDO_PROJECT, AZDO_PAT/);

    const env = { AZDO_ORG_URL: "https://dev.azure.com/acme/", AZDO_PROJECT: "App", AZDO_PAT: "pat" };
    const failing = runCli("doctor.mjs", [], { ws, env, state: { responses: [{ url: "/_apis/projects/", status: 500, body: {} }] } });
    assert.equal(failing.status, 1, failing.out);
    assert.match(failing.stdout, /Azure project check failed \(500\)\./);

    ws.write(CONFIG_PATH, { default: { backend: "azure-devops", org: "https://dev.azure.com/acme/", project: "My App" } });
    const emptyMap = runCli("doctor.mjs", [], { ws, env: { AZDO_PAT: "pat" }, state: { responses: [{ url: "/_apis/projects/", body: { id: "p" } }] } });
    assert.equal(emptyMap.status, 0, emptyMap.out);
    assert.match(emptyMap.stdout, /Azure project OK: My App/);
    assert.match(emptyMap.stdout, /status_map is empty — Azure System\.State/);
    assert.equal(emptyMap.calls[0].url, "https://dev.azure.com/acme/_apis/projects/My%20App?api-version=7.0");
    assert.equal(emptyMap.calls[0].headers.Authorization, `Basic ${Buffer.from(":pat").toString("base64")}`);

    ws.write(CONFIG_PATH, { default: { backend: "azure", statusMap: { Done: "Closed" } } });
    const mapped = runCli("doctor.mjs", [], { ws, env, state: { responses: [{ url: "/_apis/projects/", body: { id: "p" } }] } });
    assert.equal(mapped.status, 0, mapped.out);
    assert.match(mapped.stdout, /status_map present for Azure state mapping\./);
    assert.match(mapped.stdout, /Doctor finished \(Azure remote checks passed\)\./);
  }));

test("doctor (GitLab): env checks, project probe and status_map reporting", () =>
  withWorkspace({ config: { default: { backend: "gitlab" } } }, (ws) => {
    const missing = runCli("doctor.mjs", [], { ws, env: { GITLAB_TOKEN: "gl" } });
    assert.equal(missing.status, 1, missing.out);
    assert.match(missing.stdout, /GITLAB_PROJECT_ID, GITLAB_TOKEN \(optional GITLAB_URL\)/);

    const env = { GITLAB_PROJECT_ID: "group/app", GITLAB_TOKEN: "gl" };
    const failing = runCli("doctor.mjs", [], { ws, env, state: { responses: [{ url: "/api/v4/projects/", status: 401, body: {} }] } });
    assert.equal(failing.status, 1, failing.out);
    assert.match(failing.stdout, /GitLab project check failed \(401\)\./);
    assert.equal(failing.calls[0].url, "https://gitlab.com/api/v4/projects/group%2Fapp");
    assert.equal(failing.calls[0].headers["PRIVATE-TOKEN"], "gl");

    const emptyMap = runCli("doctor.mjs", [], { ws, env, state: { responses: [{ url: "/api/v4/projects/", body: { id: 1 } }] } });
    assert.equal(emptyMap.status, 0, emptyMap.out);
    assert.match(emptyMap.stdout, /GitLab project OK: group\/app/);
    assert.match(emptyMap.stdout, /status_map is empty — GitLab status will map Done→close/);

    ws.write(CONFIG_PATH, { default: { backend: "gitlab", url: "https://ignored.example", status_map: { Done: "closed" } } });
    const mapped = runCli("doctor.mjs", [], {
      ws,
      env: { ...env, GITLAB_URL: "https://git.example//" },
      state: { responses: [{ url: "/api/v4/projects/", body: { id: 1 } }] },
    });
    assert.equal(mapped.status, 0, mapped.out);
    assert.match(mapped.stdout, /status_map present for GitLab status mapping\./);
    assert.match(mapped.stdout, /Doctor finished \(GitLab remote checks passed\)\./);
    assert.equal(mapped.calls[0].url, "https://git.example/api/v4/projects/group%2Fapp");
  }));

test("doctor (Linear): env checks and team lookup (errors, non-JSON, success)", () =>
  withWorkspace({ config: { default: { backend: "linear", team: "team-1" } } }, (ws) => {
    const missing = runCli("doctor.mjs", [], { ws });
    assert.equal(missing.status, 1, missing.out);
    assert.match(missing.stdout, /Missing LINEAR_TEAM_ID and\/or LINEAR_API_TOKEN/);

    const env = { LINEAR_API_TOKEN: "lin_key" };
    const errors = runCli("doctor.mjs", [], { ws, env, state: { responses: [{ url: "api.linear.app", body: { errors: [{ message: "bad team" }] } }] } });
    assert.equal(errors.status, 1, errors.out);
    assert.match(errors.stdout, /Linear team check failed: \[\{"message":"bad team"\}\]/);
    assert.deepEqual(errors.calls[0].body.variables, { id: "team-1" });
    assert.equal(errors.calls[0].headers.Authorization, "lin_key");

    const garbage = runCli("doctor.mjs", [], { ws, env, state: { responses: [{ url: "api.linear.app", status: 502, body: "Bad Gateway" }] } });
    assert.equal(garbage.status, 1, garbage.out);
    assert.match(garbage.stdout, /Linear team check failed: \{\}/);

    const okRun = runCli("doctor.mjs", [], {
      ws,
      env: { ...env, LINEAR_TEAM_ID: "team-env" },
      state: { responses: [{ url: "api.linear.app", body: { data: { team: { id: "team-env" } } } }] },
    });
    assert.equal(okRun.status, 0, okRun.out);
    assert.match(okRun.stdout, /Linear team OK: team-env/);
    assert.match(okRun.stdout, /Doctor finished \(Linear remote checks passed\)\./);
  }));

test("doctor: unknown backend → exit 1", () =>
  withWorkspace({ config: { default: { backend: "Trello" } } }, (ws) => {
    const run = runCli("doctor.mjs", [], { ws });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /Unknown backend="trello"\. Supported: github, jira, azure-devops, linear, gitlab\./);
    assert.equal(run.calls.length, 0);
  }));
