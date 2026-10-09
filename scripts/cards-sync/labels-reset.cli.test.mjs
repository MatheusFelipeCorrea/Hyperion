import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace, runCli } from "./fixtures/cards-cli-harness.mjs";

const CATALOG = [
  { name: "type:bug", color: "D73A4A", description: "Bug report" },
  { name: "area:api", color: "#0e8a16", description: "" },
  "plain",
];
const REMOTE = ["bug", "dependencies", "Epic", "type:bug", "custom-old"];

function withWorkspace(opts, fn) {
  const ws = createWorkspace(opts);
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

const ghWrites = (run) => run.tools.filter((t) => t.tool === "gh" && t.args[0] === "label" && t.args[1] !== "list").map((t) => t.args.slice(1, 3).join(" "));

test("labels-reset (GitHub): default is a dry-run preview — diff computed, nothing written", () =>
  withWorkspace(
    { config: { default: { labels: CATALOG } }, projectYml: "project:\n  locale: pt-BR\nmanagement:\n  backend: github\n" },
    (ws) => {
      const run = runCli("labels-reset.mjs", [], { ws, env: { FAKE_GH_LABELS: JSON.stringify(REMOTE) } });
      assert.equal(run.status, 0, run.out);
      assert.match(run.stdout, /Dry-run mode \(pass --yes to apply\)/);
      assert.match(run.stdout, /Backend: github/);
      assert.match(run.stdout, /Locale: pt-BR \(3 Hyperion labels, v2 catalog\)/);
      assert.match(run.stdout, /Keep Dependabot labels: yes/);
      assert.match(run.stdout, /Existing: 5 \| Delete: 3 \| Create: 2 \| Update metadata: 1/);
      for (const name of ["Epic", "bug", "custom-old"]) assert.match(run.stdout, new RegExp(`\\(dry-run\\) delete: ${name}\\n`));
      assert.doesNotMatch(run.stdout, /delete: dependencies/);
      assert.match(run.stdout, /\(dry-run\) edit: type:bug \(#d73a4a\)/);
      assert.match(run.stdout, /\(dry-run\) create: area:api \(#0e8a16\)/);
      assert.match(run.stdout, /Dry-run complete\. Re-run with --yes to apply\./);
      assert.deepEqual(ghWrites(run), []);
      assert.deepEqual(run.tools.find((t) => t.args[1] === "list").args, ["label", "list", "--repo", "acme/app", "--limit", "200", "--json", "name"]);
    }
  ));

test("labels-reset (GitHub): explicit --dry-run + --no-keep-dependabot also deletes automation labels", () =>
  withWorkspace({ config: { default: { labels: CATALOG } } }, (ws) => {
    const run = runCli("labels-reset.mjs", ["--dry-run", "--no-keep-dependabot"], { ws, env: { FAKE_GH_LABELS: JSON.stringify(REMOTE) } });
    assert.equal(run.status, 0, run.out);
    assert.doesNotMatch(run.stdout, /pass --yes to apply/);
    assert.match(run.stdout, /Locale: en/);
    assert.match(run.stdout, /Keep Dependabot labels: no/);
    assert.match(run.stdout, /\(dry-run\) delete: dependencies/);
    assert.deepEqual(ghWrites(run), []);
  }));

test("labels-reset (GitHub): --yes deletes orphans and upserts the catalog; per-label failures only warn", () =>
  withWorkspace({ config: { default: { labels: CATALOG } } }, (ws) => {
    const run = runCli("labels-reset.mjs", ["--yes"], {
      ws,
      env: { FAKE_GH_LABELS: JSON.stringify(REMOTE), FAKE_GH_FAIL_NAMES: "custom-old,area:api" },
    });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /deleted: bug/);
    assert.match(run.stdout, /WARN: could not delete "custom-old": gh: cannot delete custom-old/);
    assert.match(run.stdout, /updated: type:bug/);
    assert.match(run.stdout, /ensured: plain/);
    assert.match(run.stdout, /WARN: could not ensure "area:api": gh: cannot create area:api/);
    assert.match(run.stdout, /Label reset complete\./);
    assert.deepEqual(ghWrites(run), ["delete Epic", "delete bug", "delete custom-old", "create area:api", "create plain", "edit type:bug"]);
    const edit = run.tools.find((t) => t.args[1] === "edit").args;
    assert.deepEqual(edit.slice(3), ["--repo", "acme/app", "--color", "d73a4a", "--description", "Bug report"]);
  }));

test("labels-reset (GitHub): `gh label list` failure is FATAL", () =>
  withWorkspace({ config: { default: { labels: CATALOG } } }, (ws) => {
    const run = runCli("labels-reset.mjs", ["--yes"], { ws });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stderr, /\[labels-reset\] FATAL: Failed to list labels:/);
  }));

test("labels-reset (GitHub): no token anywhere → exit 1", () =>
  withWorkspace({ config: { default: { labels: CATALOG } } }, (ws) => {
    const run = runCli("labels-reset.mjs", [], { ws, env: { PROJECT_SYNC_TOKEN: undefined } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /ERROR: no GitHub token\. Run: gh auth login/);
  }));

test("labels-reset: repository undetectable → exit 1", () =>
  withWorkspace({ config: { default: { labels: CATALOG } } }, (ws) => {
    const run = runCli("labels-reset.mjs", [], { ws, env: { GITHUB_REPOSITORY: undefined } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /ERROR: cannot detect repository from git remote\./);
  }));

test("labels-reset: empty catalog (no projects-map.json) → exit 1", () =>
  withWorkspace({}, (ws) => {
    const run = runCli("labels-reset.mjs", ["--yes"], { ws });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /ERROR: no labels loaded \(locale=en, file=\?\)/);
  }));

test("labels-reset: Azure DevOps and Linear have nothing to reset (exit 0); unknown backends exit 1", () =>
  withWorkspace({ config: { default: { backend: "Azure-DevOps" } } }, (ws) => {
    const azure = runCli("labels-reset.mjs", ["--yes"], { ws });
    assert.equal(azure.status, 0, azure.out);
    assert.match(azure.stdout, /Backend is Azure DevOps — nothing to reset here\./);

    ws.write(".github/cards/config/projects-map.json", { default: { backend: "linear" } });
    const linear = runCli("labels-reset.mjs", ["--yes"], { ws });
    assert.equal(linear.status, 0, linear.out);
    assert.match(linear.stdout, /Backend is Linear — nothing to reset here\./);

    ws.write(".github/cards/config/projects-map.json", { default: {} });
    ws.write(".github/project.yml", "management:\n  backend: jira\n");
    const jira = runCli("labels-reset.mjs", [], { ws });
    assert.equal(jira.status, 1, jira.out);
    assert.match(jira.stdout, /Backend "jira" not recognized for label reset\. Supported: github, gitlab\./);
    assert.equal(azure.tools.length + linear.tools.length + jira.tools.length, 0, "no gh/git calls for non-GitHub backends");
  }));

test("labels-reset: project.yml backend with an inline comment is honoured (not silently github)", () =>
  withWorkspace({ config: { default: { labels: CATALOG } }, projectYml: "management:\n  backend: linear # tracker\n" }, (ws) => {
    const run = runCli("labels-reset.mjs", ["--yes"], { ws });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Backend is Linear — nothing to reset here\./);
    assert.equal(run.tools.length, 0);
  }));

const GITLAB_ENV = { GITLAB_PROJECT_ID: "group/app", GITLAB_TOKEN: "gl-token" };
const LABELS_FILE = {
  "labels.en.json": [{ name: "type:bug", color: "d73a4a", description: "Bug report" }, { name: "area:api", color: "0e8a16" }, { name: "plain", color: "cccccc" }],
};
const gitlabWorkspace = () =>
  createWorkspace({
    config: { default: { backend: "gitlab", labelsFile: "labels.{locale}.json" } },
    files: { ".github/cards/config/labels.en.json": LABELS_FILE["labels.en.json"] },
  });

test("labels-reset (GitLab): dry-run pages through the Labels API and plans the diff", () => {
  const ws = gitlabWorkspace();
  try {
    const remote = [...Array.from({ length: 100 }, (_, i) => `old-${i}`), "type:bug"];
    const run = runCli("labels-reset.mjs", [], { ws, env: GITLAB_ENV, state: { gitlab: { labels: remote } } });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Backend: gitlab/);
    assert.match(run.stdout, /Existing: 101 \| Delete: 100 \| Create: 2 \| Update metadata: 1/);
    assert.match(run.stdout, /\(dry-run\) delete: old-99/);
    assert.match(run.stdout, /\(dry-run\) edit: type:bug \(#d73a4a\)/);
    assert.match(run.stdout, /\(dry-run\) create: area:api \(#0e8a16\)/);
    assert.deepEqual(
      run.calls.map((c) => `${c.method} ${c.url}`),
      [1, 2].map((p) => `GET https://gitlab.com/api/v4/projects/group%2Fapp/labels?per_page=100&page=${p}`)
    );
    assert.equal(run.calls[0].headers["PRIVATE-TOKEN"], "gl-token");
  } finally {
    ws.cleanup();
  }
});

test("labels-reset (GitLab): --yes deletes/updates/creates via REST; per-label failures only warn", () => {
  const ws = gitlabWorkspace();
  try {
    const run = runCli("labels-reset.mjs", ["--yes"], {
      ws,
      env: { ...GITLAB_ENV, GITLAB_URL: "https://git.example/" },
      state: { gitlab: { labels: ["type:bug", "stale", "stale-locked"], fail: ["stale-locked", "area:api"] } },
    });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /deleted: stale\n/);
    assert.match(run.stdout, /WARN: could not delete "stale-locked": GitLab request failed \(403\)/);
    assert.match(run.stdout, /updated: type:bug/);
    assert.match(run.stdout, /WARN: could not ensure "area:api": GitLab request failed \(403\)/);
    assert.match(run.stdout, /ensured: plain/);
    assert.match(run.stdout, /Label reset complete\./);

    const base = "https://git.example/api/v4/projects/group%2Fapp/labels";
    const writes = run.calls.filter((c) => c.method !== "GET");
    assert.deepEqual(
      writes.map((c) => `${c.method} ${c.url}`),
      [`DELETE ${base}/stale`, `DELETE ${base}/stale-locked`, `POST ${base}`, `POST ${base}`, `PUT ${base}/type%3Abug`]
    );
    assert.deepEqual(writes[2].body, { name: "area:api", color: "#0e8a16", description: "" });
    assert.deepEqual(writes[3].body, { name: "plain", color: "#cccccc", description: "" });
    assert.deepEqual(writes[4].body, { color: "#d73a4a", description: "Bug report" });
    assert.equal(writes[2].headers["Content-Type"], "application/json");
  } finally {
    ws.cleanup();
  }
});

test("labels-reset (GitLab): list failure is FATAL; missing env exits 1 before any request", () => {
  const ws = gitlabWorkspace();
  try {
    const failing = runCli("labels-reset.mjs", ["--yes"], { ws, env: GITLAB_ENV, state: { gitlab: { labels: [], listStatus: 500 } } });
    assert.equal(failing.status, 1, failing.out);
    assert.match(failing.stderr, /FATAL: GitLab request failed \(500\): \{"message":"upstream error"\}/);

    const proxyPage = `<html>\n<head><title>502 Bad Gateway</title></head>\n<body>${"x".repeat(500)}</body>\n</html>`;
    const badGateway = runCli("labels-reset.mjs", ["--yes"], { ws, env: GITLAB_ENV, state: { responses: [{ url: "/labels", status: 502, body: proxyPage }] } });
    assert.equal(badGateway.status, 1, badGateway.out);
    assert.match(badGateway.stderr, /FATAL: GitLab request failed \(502\): <html> <head><title>502 Bad Gateway<\/title><\/head> <body>x+\n/);
    assert.doesNotMatch(badGateway.stderr, /JSON|x{250}/);

    const missing = runCli("labels-reset.mjs", ["--yes"], { ws, env: { GITLAB_TOKEN: "gl-token" } });
    assert.equal(missing.status, 1, missing.out);
    assert.match(missing.stdout, /ERROR: GitLab backend needs GITLAB_PROJECT_ID and GITLAB_TOKEN/);
    assert.equal(missing.calls.length, 0);
  } finally {
    ws.cleanup();
  }
});
