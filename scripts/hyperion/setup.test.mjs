import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, FAULT_SPAWN, hyperionDir, kitWorkspace, linearEnv, makeBin, repoRoot, runNodeAsync } from "./test-support/cli-harness.mjs";

const setup = join(hyperionDir, "setup.mjs");
const ghFail = makeBin({ gh: "fail" });

after(cleanupTmp);

/** setup.mjs in `cwd`; gh is always "missing" so no real `gh auth token` is ever read. */
const run = (cwd, args = [], env = {}, opts = {}) => runNodeAsync(setup, args, { cwd, env, binDir: ghFail, ...opts });

describe("setup.mjs language flags", { concurrency: true }, () => {
  it("rejects invalid language tags", async () => {
    const r = await run(kitWorkspace(), ["--locale=not a tag!", "--skip-cards"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Invalid language tag\(s\): not a tag!/);
  });

  it("rejects empty --languages entries up front, in the repo language, without touching project.yml", async () => {
    const cwd = kitWorkspace();
    for (const args of [["--languages", ","], ["--languages=pt-BR,,en"], ["--languages="]]) {
      const r = await run(cwd, [...args, "--skip-cards"]);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stdout, /❌ --languages has an empty entry \('.*'\) — pass comma-separated BCP 47 tags/);
      assert.doesNotMatch(r.out, /FATAL/);
    }
    assert.equal(readFileSync(join(cwd, ".github", "project.yml"), "utf8"), "version: 1\nname: App\nlocale: en\n");

    const pt = kitWorkspace({ ".github/project.yml": "version: 1\nname: App\nlocale: pt-BR\n" });
    const r = await run(pt, ["--locale", "pt-BR", "--languages", " , ", "--skip-cards"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /--languages tem uma entrada vazia \(' , '\)/);
  });

  it("cannot save a language before project.yml exists, and stops on blockers", async () => {
    const cwd = kitWorkspace({ ".github/project.yml": null, ".github/cards/config/projects-map.json": null });
    const r = await run(cwd, ["--locale", "pt-BR"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /project\.yml missing — run \/setup first; --locale\/--languages not saved/);
    assert.match(r.stdout, /❌ Missing `.*projects-map\.json`/);
    assert.match(r.stdout, /1\. Ask: "Configura o Hyperion neste repo" or \/setup/);
  });

  it("suggests a language when none is configured; --skip-cards stops after the checks", async () => {
    const cwd = kitWorkspace({ ".github/project.yml": null, "README.md": "This is the tool for the team and how to use it with the cards.\n" });
    const r = await run(cwd, ["--skip-cards"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Team language not set — detected en/);
    assert.match(r.stdout, /project\.yml missing — cards sync can run/);
    assert.match(r.stdout, /No GitHub token — sync will be skipped/);
    assert.match(r.stdout, /Skipped cards bootstrap \(--skip-cards\)/);
  });
});

describe("setup.mjs bootstrap", { concurrency: true }, () => {
  it("--yes saves languages, applies workflows, runs cards:init and finishes", async () => {
    const cwd = kitWorkspace({ ".cursor/rules/hyperion.mdc": null }, { gitRemote: true });
    const r = await run(cwd, ["--locale", "pt-BR", "--languages=pt-BR,en", "--yes", "--skip-sync", "--install-hook"], linearEnv());
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Language saved: pt-BR, en \(primary pt-BR\)/);
    assert.match(readFileSync(join(cwd, ".github", "project.yml"), "utf8"), /locale: pt-BR/);
    assert.match(r.stdout, /Installed \.cursor\/rules\/hyperion\.mdc/);
    assert.equal(
      readFileSync(join(cwd, ".cursor", "rules", "hyperion.mdc"), "utf8"),
      readFileSync(join(repoRoot, ".cursor", "rules", "hyperion.mdc"), "utf8")
    );
    assert.ok(existsSync(join(cwd, ".github", "workflows")), "pipeline-apply --yes writes hyperion-* workflows");
    assert.match(r.stdout, /init\.mjs --yes --skip-sync --install-hook/);
    assert.match(r.stdout, /Hyperion setup complete\./);
    assert.doesNotMatch(r.stdout, /1\. Ask: "Configura/);
  });

  it("without --yes only plans the pipeline; a failing cards:init fails setup", async () => {
    // A directory where the rules file goes makes install-cursor-rules fail: setup only warns.
    const cwd = kitWorkspace({ ".cursor/rules/hyperion.mdc": null, ".cursor/rules/hyperion.mdc/keep": "" }, { backend: "azure" });
    const r = await run(cwd, [], { GITHUB_REPOSITORY: "acme/app" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /Cursor rules install skipped/);
    assert.match(r.stdout, /pipeline-plan\.mjs/);
    assert.equal(existsSync(join(cwd, ".github", "workflows")), false);
    assert.match(r.stdout, /cards:init failed — fix issues above/);
  });

  it("unexpected errors are reported as FATAL", async () => {
    const r = await run(kitWorkspace(), [], { PROJECT_SYNC_TOKEN: "test-token" }, { nodeArgs: FAULT_SPAWN });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FATAL: injected spawnSync failure/);
  });
});
