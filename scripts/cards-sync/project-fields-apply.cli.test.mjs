import test from "node:test";
import assert from "node:assert/strict";
import { HEALTHY_PROJECT_FIELDS, createWorkspace, runCli } from "./fixtures/cards-cli-harness.mjs";

const CONFIG = { default: { projectNumber: 4, projectOwner: "acme-org" } };
const field = (name) => ({ ...HEALTHY_PROJECT_FIELDS.find((f) => f.name === name) });
const graphqlCalls = (run) => run.calls.filter((c) => c.url === "https://api.github.com/graphql");
const mutations = (run) => graphqlCalls(run).filter((c) => /^\s*mutation/.test(c.body.query));

function withWorkspace(opts, fn) {
  const ws = createWorkspace(opts);
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

test("project-fields-apply: dry-run reports renames (aliases, case) and creations without writing", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const fields = [field("Status"), { ...field("Type"), name: "Tipo" }, { ...field("Priority"), name: "priority" }, field("Sprint")];
    const run = runCli("project-fields-apply.mjs", [], { ws, state: { github: { project: { scope: "repository", fields } } } });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Dry-run mode \(pass --yes to apply\)/);
    assert.match(run.stdout, /Repository: acme\/app/);
    assert.match(run.stdout, /Project: owner=acme-org number=4/);
    assert.match(run.stdout, /\(dry-run\) rename: "Tipo" -> "Type"/);
    assert.match(run.stdout, /\(dry-run\) rename: "priority" -> "Priority"/);
    for (const name of ["Story Points", "Reporter", "Parent \\(Epic\\/Feature\\)", "Due Date"]) {
      assert.match(run.stdout, new RegExp(`\\(dry-run\\) create: ${name}`));
    }
    assert.match(run.stdout, /OK: 2 \| Created: 4 \| Renamed: 2/);
    assert.match(run.stdout, /Dry-run complete\. Re-run with --yes to apply\./);
    assert.equal(mutations(run).length, 0, "dry-run never mutates");
    assert.equal(graphqlCalls(run)[0].headers.Authorization, "Bearer test-token");
    assert.deepEqual(graphqlCalls(run)[0].body.variables, { owner: "acme-org", name: "app", number: 4 });
  }));

test("project-fields-apply: dry-run on a complete Project is a no-op summary", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const run = runCli("project-fields-apply.mjs", [], { ws, state: { github: { project: { scope: "user", fields: HEALTHY_PROJECT_FIELDS } } } });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /OK: 8 \| Created: 0 \| Renamed: 0/);
    assert.doesNotMatch(run.stdout, /Dry-run complete/);
  }));

test("project-fields-apply: --yes creates every missing kind of field and renames to the fieldMap name", () =>
  withWorkspace(
    {
      config: {
        default: { projectNumber: 4, fieldMap: { type: "Kind" }, sprintField: { durationDays: 7, startDate: "2026-01-05", seedIterations: [{ title: "S1", startDate: "2026-01-05" }] } },
      },
    },
    (ws) => {
      const run = runCli("project-fields-apply.mjs", ["--yes"], {
        ws,
        state: { github: { project: { scope: "organization", id: "PVT_org", fields: [{ ...field("Type"), name: "Tipo" }] } } },
      });
      assert.equal(run.status, 0, run.out);
      assert.doesNotMatch(run.stdout, /Dry-run/);
      assert.match(run.stdout, /MISSING: Status \(no Status field found/);
      assert.match(run.stdout, /~ renamed: "Tipo" -> "Kind"/);
      assert.match(run.stdout, /\+ created: Priority/);
      assert.match(run.stdout, /\+ created: Due Date/);
      assert.match(run.stdout, /OK: 0 \| Created: 6 \| Renamed: 1/);

      const sent = mutations(run).map((c) => ({ query: c.body.query, vars: c.body.variables }));
      const rename = sent.find((m) => /updateProjectV2Field/.test(m.query));
      assert.deepEqual(rename.vars, { fieldId: "F_type", name: "Kind" });
      const created = sent.filter((m) => /createProjectV2Field/.test(m.query));
      const kindOf = (name) => created.find((m) => m.vars.name === name)?.query.match(/dataType: (\w+)/)[1];
      assert.equal(kindOf("Priority"), "SINGLE_SELECT");
      assert.equal(kindOf("Sprint"), "ITERATION");
      assert.equal(kindOf("Story Points"), "NUMBER");
      assert.equal(kindOf("Reporter"), "TEXT");
      assert.equal(kindOf("Parent (Epic/Feature)"), "TEXT");
      assert.equal(kindOf("Due Date"), "DATE");
      assert.ok(created.every((m) => m.vars.projectId === "PVT_org"));
      const sprint = created.find((m) => m.vars.name === "Sprint").vars.config;
      assert.deepEqual(sprint, { duration: 7, startDate: "2026-01-05", iterations: [{ title: "S1", startDate: "2026-01-05", duration: 7 }] });
      assert.ok(created.find((m) => m.vars.name === "Priority").vars.options.length >= 4);
    }
  ));

test("project-fields-apply: a rejected mutation is FATAL (exit 1)", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const run = runCli("project-fields-apply.mjs", ["--yes"], {
      ws,
      state: { github: { failMutations: true, project: { scope: "repository", fields: [field("Status")] } } },
    });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stderr, /\[project-fields-apply\] FATAL: GraphQL failed: .*mutation refused/s);
  }));

test("project-fields-apply: Project number configured but not found → exit 1", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const run = runCli("project-fields-apply.mjs", [], { ws, state: { github: {} } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /ERROR: Project #4 not found for owner "acme-org"\./);
    assert.equal(graphqlCalls(run).length, 3, "tries repository, user and organization scopes");
  }));

test("project-fields-apply: no projects-map.json → no projectNumber → exit 1 before any API call", () =>
  withWorkspace({}, (ws) => {
    const run = runCli("project-fields-apply.mjs", ["--yes"], { ws });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /ERROR: projects-map\.json has no projectNumber configured/);
    assert.match(run.stdout, /doesn't create one/);
    assert.equal(run.calls.length, 0);
  }));

test("project-fields-apply: missing token → exit 1 (falls back to `gh auth token`)", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const run = runCli("project-fields-apply.mjs", [], { ws, env: { PROJECT_SYNC_TOKEN: undefined } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /ERROR: no GitHub token\. Run: gh auth login/);
    assert.ok(run.tools.some((t) => t.tool === "gh" && t.args.join(" ") === "auth token"));
  }));

test("project-fields-apply: repository undetectable (no env, no git remote) → exit 1", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const run = runCli("project-fields-apply.mjs", [], { ws, env: { GITHUB_REPOSITORY: undefined } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /ERROR: cannot detect repository from git remote\./);
    assert.ok(run.tools.some((t) => t.tool === "git" && t.args.join(" ") === "remote get-url origin"));
  }));
