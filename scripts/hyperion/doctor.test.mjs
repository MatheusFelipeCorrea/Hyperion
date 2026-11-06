import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cleanupTmp, fetchMockEnv, hyperionDir, kitWorkspace, makeBin, makeTmp, runNodeAsync } from "./test-support/cli-harness.mjs";

// scripts/hyperion/doctor.mjs (kit health), which also runs cards-sync/doctor.mjs.
const doctor = join(hyperionDir, "doctor.mjs");
const ghFail = makeBin({ gh: "fail" });
const GITHUB = { GITHUB_REPOSITORY: "acme/app", PROJECT_SYNC_TOKEN: "test-token" };

after(cleanupTmp);

const run = (cwd, args = [], env = GITHUB) => runNodeAsync(doctor, args, { cwd, env, binDir: ghFail });

/** projects-map for the GitHub backend; projectNumber 0 + no auto-create keeps the cards doctor offline. */
const githubMap = (extra = {}) => ({
  ".github/cards/config/projects-map.json": { default: { backend: "github", locale: "en", autoCreateProject: false, ...extra } },
});

/** GitHub Project with every mapped field, but a Status field missing most Hyperion columns. */
const PROJECT_ROUTE = `const f = (__typename, name, extra = {}) => ({ __typename, id: name, name, ...extra });
export default (req) =>
  req.url === "https://api.github.com/graphql"
    ? { data: { repository: { projectV2: { id: "P", fields: { nodes: [
        f("ProjectV2SingleSelectField", "Status", { options: [{ id: "o", name: "Backlog" }] }),
        f("ProjectV2SingleSelectField", "Type", { options: [] }),
        f("ProjectV2SingleSelectField", "Priority", { options: [] }),
        f("ProjectV2IterationField", "Sprint", { configuration: { iterations: [] } }),
        f("ProjectV2Field", "Story Points"),
        f("ProjectV2Field", "Reporter"),
        f("ProjectV2Field", "Parent (Epic/Feature)"),
        f("ProjectV2Field", "Due Date"),
      ] } } } } }
    : undefined;
`;

describe("hyperion doctor.mjs", { concurrency: true }, () => {
  it("a complete workspace has no issues", async () => {
    const r = await run(kitWorkspace(githubMap(), { gitRemote: true }), ["--skip-cards"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Repository: acme\/app/);
    assert.match(r.stdout, /GitHub token: available/);
    assert.match(r.stdout, /memory\/PROJECT\.md: filled/);
    assert.match(r.stdout, /Kit structure looks good\./);
    assert.match(r.stdout, /Doctor complete — no issues\./);
  });

  it("warnings (and an external CI provider without the sync workflow) still exit 0", async () => {
    const cwd = kitWorkspace({ ...githubMap(), ".gitlab-ci.yml": "stages: [test]\n", ".github/memory/PROJECT.md": null });
    const r = await run(cwd, ["--skip-cards"], {});
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Repository: not detected/);
    assert.match(r.stdout, /GitHub token: missing/);
    assert.match(r.stdout, /memory\/PROJECT\.md: template\/empty/);
    assert.match(r.stdout, /GitLab: add `include: - local: \.gitlab\/hyperion-ci\.yml`/);
    assert.match(r.stdout, /hyperion-sync-cards\.yml missing — run: npm run hyperion:pipeline-apply/);
    assert.match(r.stdout, /Doctor finished with \d+ warning\(s\)/);
  });

  it("blocking issues exit 1", async () => {
    const r = await run(makeTmp("doctor-empty-"));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Doctor finished with 2 blocking issue\(s\)/);
  });

  it("counts cards-sync doctor warnings (--yes is forwarded)", async () => {
    const r = await run(kitWorkspace(githubMap()), ["--yes"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Running cards-sync doctor/);
    assert.match(r.stdout, /doctor\.mjs --yes/);
    assert.match(r.stdout, /Doctor finished with \d+ warning\(s\)/);
  });

  it("a failing cards-sync doctor fails the kit doctor", async () => {
    const r = await run(kitWorkspace({}, { backend: "azure" }));
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /cards-sync doctor reported issues \(exit 1\)\./);
  });

  it("a cards-sync doctor that finished but exited non-zero fails the kit doctor on every platform", async () => {
    const cwd = kitWorkspace(githubMap({ projectNumber: 1 }));
    const r = await run(cwd, [], { ...GITHUB, ...fetchMockEnv(PROJECT_ROUTE) });
    assert.match(r.stdout, /Status field is missing Hyperion options/);
    assert.match(r.stdout, /Doctor finished\./, "the cards doctor ran to completion");
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /❌ cards-sync doctor reported issues \(exit 1\)\./);
    assert.doesNotMatch(r.stdout, /Doctor complete|warning\(s\) — kit usable/);
  });

  it("reports unexpected errors as FATAL", async () => {
    const r = await run(kitWorkspace({ ".github/workflows": "not a directory\n" }), ["--skip-cards"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /❌ FATAL: ENOTDIR: not a directory, scandir '.*workflows'/);
  });
});
