import test from "node:test";
import assert from "node:assert/strict";
import { HEALTHY_PROJECT_FIELDS, createWorkspace, runCli } from "./fixtures/cards-cli-harness.mjs";

// cards:init spawns labels-reset → doctor → validate → sync --dry-run → sync → install-hook
// as real child processes; `chain: true` routes their fetch through the same mock state.
const LABELS = [{ name: "type:bug", color: "d73a4a", description: "Bug" }];
const CONFIG = { default: { projectNumber: 3, createMissingLabels: false, labels: LABELS } };
const HEALTHY = { github: { project: { scope: "repository", fields: HEALTHY_PROJECT_FIELDS } } };
const GH_OK = { FAKE_GH_LABELS: JSON.stringify(["type:bug"]) };

function withWorkspace(opts, fn) {
  const ws = createWorkspace(opts);
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

const initLines = (run) => run.stdout.split("\n").filter((l) => l.startsWith("[cards-init] Step"));

test("cards:init: missing projects-map.json → exit 1 before running any step (repo from git remote)", () =>
  withWorkspace({}, (ws) => {
    const run = runCli("init.mjs", [], { ws, env: { GITHUB_REPOSITORY: undefined, FAKE_GIT_ORIGIN: "git@github.com:acme/app.git" } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /Repository: acme\/app \(git auto-detect\)/);
    assert.match(run.stdout, /Token: available/);
    assert.match(run.stdout, /ERROR: missing \.github\/cards\/config\/projects-map\.json/);
    assert.deepEqual(initLines(run), []);
  }));

test("cards:init reports the real repository source: GITHUB_REPOSITORY over a git remote, else fallback", () =>
  withWorkspace({}, (ws) => {
    const fromEnv = runCli("init.mjs", [], { ws, env: { FAKE_GIT_ORIGIN: "git@github.com:octo/other.git" } });
    assert.equal(fromEnv.status, 1, fromEnv.out);
    assert.match(fromEnv.stdout, /Repository: acme\/app \(GITHUB_REPOSITORY\)/);
    assert.ok(!fromEnv.tools.some((t) => t.tool === "git"), "git isn't consulted when GITHUB_REPOSITORY is set");

    const fallback = runCli("init.mjs", [], { ws, env: { GITHUB_REPOSITORY: undefined } });
    assert.equal(fallback.status, 1, fallback.out);
    assert.match(fallback.stdout, /Repository: unknown\/unknown \(fallback\)/);
  }));

test("cards:init --yes --install-hook: full GitHub bootstrap succeeds end to end", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const run = runCli("init.mjs", ["--yes", "--install-hook"], {
      ws,
      chain: true,
      env: { ...GH_OK, FAKE_GIT_HOOKS: ".git/hooks" },
      state: HEALTHY,
    });
    assert.equal(run.status, 0, run.out);
    assert.deepEqual(initLines(run), [
      "[cards-init] Step 1/6 — Auto-discover GitHub Project number...",
      "[cards-init] Step 2/6 — Reset repository labels (Hyperion catalog)...",
      "[cards-init] Step 3/6 — Doctor (local + remote checks)...",
      "[cards-init] Step 4/6 — Validate cards...",
      "[cards-init] Step 5/6 — Dry-run sync...",
      "[cards-init] Step 6/6 — Real sync (--yes)...",
    ]);
    assert.match(run.stdout, /Repository: acme\/app \(GITHUB_REPOSITORY\)/);
    assert.match(run.stdout, /= projectNumber already set \(#3\)/);
    assert.match(run.stdout, /→ node .*labels-reset\.mjs --yes/);
    assert.match(run.stdout, /\[labels-reset\]\s+updated: type:bug/);
    assert.match(run.stdout, /\[doctor\] ✅ Doctor finished\./);
    assert.match(run.stdout, /\[validate\] No card files found under \.github\/cards\//);
    assert.match(run.stdout, /\[cards-sync\] Dry-run: yes/);
    assert.match(run.stdout, /\[cards-sync\] Dry-run: no/);
    assert.match(run.stdout, /Installing pre-commit hook\.\.\./);
    assert.match(run.stdout, /✅ Init complete\./);
    assert.match(ws.read(".git/hooks/pre-commit"), /# hyperion-cards-validate/);
    assert.match(run.stdout, /\[doctor\] ✅ Project found\./, "doctor's Project lookup went through the mock");
    assert.ok(run.tools.some((t) => t.tool === "gh" && t.args[1] === "edit"), "labels were applied live");
  }));

test("cards:init --install-hook (no --yes): labels preview only, real sync skipped; hook failure is fatal", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const run = runCli("init.mjs", ["--install-hook"], { ws, chain: true, env: GH_OK, state: HEALTHY });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /→ node .*labels-reset\.mjs --dry-run/);
    assert.match(run.stdout, /\[labels-reset\]\s+\(dry-run\) edit: type:bug/);
    assert.ok(!run.tools.some((t) => t.tool === "gh" && t.args[1] === "edit"), "no live label writes");
    assert.match(run.stdout, /Step 6\/6 — Real sync skipped\./);
    assert.match(run.stdout, /npm run cards:init -- --yes/);
    assert.doesNotMatch(run.stdout, /Dry-run: no/);
    assert.match(run.stdout, /Installing pre-commit hook\.\.\./);
    assert.match(run.stderr, /\[install-hook\] Not a git repository/);
    assert.doesNotMatch(run.stdout, /Init complete/);
  }));

test("cards:init --skip-sync: stops after the dry-run", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const run = runCli("init.mjs", ["--skip-sync"], { ws, chain: true, env: GH_OK, state: HEALTHY });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Step 6\/6 — Skipped real sync \(--skip-sync\)/);
    assert.doesNotMatch(run.stdout, /Dry-run: no/);
  }));

test("cards:init on a non-GitHub backend without a GitHub token: discovery and real sync skipped", () =>
  withWorkspace({ config: { default: { backend: "linear", team: "team-1" } } }, (ws) => {
    const run = runCli("init.mjs", ["--yes"], {
      ws,
      chain: true,
      env: { PROJECT_SYNC_TOKEN: undefined, LINEAR_TEAM_ID: "team-1", LINEAR_API_TOKEN: "lin_key" },
      state: { responses: [{ url: "api.linear.app", body: { data: { team: { id: "team-1", name: "Core" } } } }] },
    });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Token: missing — see .*github-cli-setup\.md/);
    assert.match(run.stdout, /Backend is 'linear' — cards:init is optimized for GitHub/);
    assert.match(run.stdout, /Step 1\/6 — Skipped project discovery \(no token or repo\)/);
    assert.match(run.stdout, /\[labels-reset\] Backend is Linear — nothing to reset here\./);
    assert.match(run.stdout, /\[doctor\] ✅ Linear team OK: Core/);
    assert.match(run.stdout, /Step 6\/6 — Skipped real sync \(no token\)\. Run: npm run cards:sync/);
    assert.match(run.stdout, /✅ Init complete\./);
  }));

test("cards:init step 1 reports each project-discovery outcome (then stops on a labels failure)", () => {
  const cases = [
    {
      name: "discovered",
      state: { github: { projects: { repository: [{ number: 7, title: "app Hyperion Project", id: "P7" }] } } },
      expect: /✅ Found project #7 — "app Hyperion Project"\n.*Saved to projects-map\.json/,
      check: (ws) => {
        const { projectNumber, projectOwner } = ws.readJson(".github/cards/config/projects-map.json").default;
        assert.deepEqual({ projectNumber, projectOwner }, { projectNumber: 7, projectOwner: "acme" });
      },
    },
    {
      name: "ambiguous",
      state: { github: { projects: { repository: [{ number: 1, title: "Alpha" }, { number: 2, title: "Beta" }] } } },
      expect: /Multiple projects found[\s\S]*- #1: Alpha\n.*- #2: Beta/,
    },
    { name: "not found", state: { github: {} }, expect: /= No project yet — sync will auto-create on first real sync/ },
    { name: "disabled", config: { autoDiscoverProject: false }, state: { github: {} }, expect: /= Skipped discovery \(auto_discover_disabled\)/ },
    { name: "throws", state: { github: { projects: { repository: [null] } } }, expect: /⚠️ {2}Project discovery failed: / },
  ];
  // No label catalog configured → labels-reset (step 2) exits 1 right away, so each case stays cheap.
  for (const c of cases) {
    withWorkspace({ config: { default: { ...c.config } } }, (ws) => {
      const run = runCli("init.mjs", [], { ws, chain: true, state: c.state });
      assert.equal(run.status, 1, `${c.name}: ${run.out}`);
      assert.match(run.stdout, c.expect, c.name);
      assert.match(run.stdout, /\[labels-reset\] ERROR: no labels loaded/, c.name);
      assert.doesNotMatch(run.stdout, /Step [3-6]\/6/, c.name);
      c.check?.(ws);
    });
  }
});

test("cards:init: a failing doctor stops the bootstrap", () =>
  withWorkspace({ config: CONFIG }, (ws) => {
    const fields = HEALTHY_PROJECT_FIELDS.filter((f) => f.name !== "Sprint");
    const run = runCli("init.mjs", [], { ws, chain: true, env: GH_OK, state: { github: { project: { scope: "repository", fields } } } });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /\[doctor\] ⚠️ Missing required Project fields: Sprint/);
    assert.match(run.stdout, /Doctor reported issues — fix them and re-run cards:init/);
    assert.doesNotMatch(run.stdout, /Validate cards/);
  }));

test("cards:init: invalid cards stop the bootstrap before any sync", () =>
  withWorkspace(
    { config: CONFIG, files: { ".github/cards/stories/_orphan/BAD-1.md": "---\ncard_id: BAD-1\ntitle: Bad\ntype: Bogus\n---\n\nBody\n" } },
    (ws) => {
      const run = runCli("init.mjs", [], { ws, chain: true, env: GH_OK, state: HEALTHY });
      assert.equal(run.status, 1, run.out);
      assert.match(run.stdout, /\[validate\] ❌ Cards validation failed/);
      assert.doesNotMatch(run.stdout, /Dry-run sync/);
    }
  ));