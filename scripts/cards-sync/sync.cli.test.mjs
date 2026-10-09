import test from "node:test";
import assert from "node:assert/strict";
import { cardMarkdown } from "./backends/sync-fixture.mjs";
import { createWorkspace, runCli } from "./fixtures/cards-cli-harness.mjs";

const CONFIG_PATH = ".github/cards/config/projects-map.json";
const graphqlQueries = (run) => run.calls.filter((c) => c.url === "https://api.github.com/graphql").map((c) => c.body.query);

function withWorkspace(opts, fn) {
  const ws = createWorkspace(opts);
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

test("sync: auto-creates the Project and saves its number to the repositories entry in effect", () =>
  withWorkspace(
    {
      // doctor left the repositories entry at 0; the default's 7 is shadowed by it.
      config: { default: { projectNumber: 7, createMissingLabels: false }, repositories: { "acme/app": { projectNumber: 0 } } },
      files: { ".github/cards/stories/PROJ-S1.md": cardMarkdown({ id: "PROJ-S1" }) },
    },
    (ws) => {
      const run = runCli("sync.mjs", [], {
        ws,
        state: { github: { projects: { repository: [], user: [], organization: [] }, newProjectNumber: 12 } },
      });
      assert.equal(run.status, 0, run.out);
      assert.match(run.stdout, /\[cards-sync\] Project created: "app Hyperion Project" \(number 12\)/);
      assert.ok(
        run.stdout.includes('[cards-sync]   projects-map.json updated: repositories["acme/app"].projectNumber=12, projectOwner=acme'),
        run.stdout
      );
      const saved = ws.readJson(CONFIG_PATH);
      assert.deepEqual(saved.repositories["acme/app"], { projectNumber: 12, projectOwner: "acme" });
      assert.equal(saved.default.projectNumber, 7);
      assert.equal(run.state.github.issues.length, 1, "the card's issue was created once");
      assert.equal(graphqlQueries(run).filter((q) => /createProjectV2\(/.test(q)).length, 1);
    }
  ));

test("sync: live-write prompt on a TTY treats closed stdin as 'no' → nothing written, exit 1", () =>
  withWorkspace({ config: { default: {} }, files: { ".github/cards/stories/PROJ-S1.md": cardMarkdown({ id: "PROJ-S1" }) } }, (ws) => {
    const before = ws.read(CONFIG_PATH);
    const run = runCli("sync.mjs", [], { ws, tty: true, input: "", state: { github: {} } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /Type "yes" to continue: /);
    assert.match(run.stdout, /\[cards-sync\] No answer \(stdin closed\) — treating it as "no"\./);
    assert.match(run.stdout, /\[cards-sync\] Aborted — nothing written\. Pass --yes \(or CARDS_SYNC_YES=true\) to skip this prompt\./);
    assert.equal(run.calls.length, 0);
    assert.equal(ws.read(CONFIG_PATH), before);
  }));

test("sync: live-write prompt answered with anything but 'yes' aborts; 'yes' proceeds", () =>
  withWorkspace({ config: { default: {} } }, (ws) => {
    const declined = runCli("sync.mjs", [], { ws, tty: true, input: "y\n", state: { github: {} } });
    assert.equal(declined.status, 1, declined.out);
    assert.doesNotMatch(declined.stdout, /stdin closed/);
    assert.match(declined.stdout, /Aborted — nothing written/);

    const confirmed = runCli("sync.mjs", [], { ws, tty: true, input: "yes\n", state: { github: { projects: { repository: [], user: [], organization: [] } } } });
    assert.equal(confirmed.status, 0, confirmed.out);
    assert.doesNotMatch(confirmed.stdout, /Aborted/);
    assert.match(confirmed.stdout, /\[cards-sync\] No card files found/);
  }));
