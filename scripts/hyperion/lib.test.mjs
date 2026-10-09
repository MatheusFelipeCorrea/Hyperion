import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectLanguageHealth,
  isMemoryFileFilled,
  parseNodeMajor,
  pathExists,
  readTextIfExists,
  runNodeScript,
  runNodeScriptAsync,
} from "./lib.mjs";
import { cleanupTmp, hyperionDir, kitWorkspace, makeBin, makeTmp, runNode, writeFiles } from "./test-support/cli-harness.mjs";

after(cleanupTmp);

async function filled(content) {
  const dir = makeTmp("lib-mem-");
  writeFileSync(join(dir, "PROJECT.md"), content);
  return isMemoryFileFilled(join(dir, "PROJECT.md"));
}

describe("lib: file helpers", () => {
  it("pathExists / readTextIfExists", async () => {
    const dir = writeFiles(makeTmp("lib-"), { "a.txt": "hello" });
    assert.equal(await pathExists(join(dir, "a.txt")), true);
    assert.equal(await pathExists(join(dir, "b.txt")), false);
    assert.equal(await readTextIfExists(join(dir, "a.txt")), "hello");
    assert.equal(await readTextIfExists(join(dir, "b.txt")), null);
  });

  it("parseNodeMajor matches process.version", () => {
    assert.equal(parseNodeMajor(), Number(process.versions.node.split(".")[0]));
  });
});

describe("lib: isMemoryFileFilled", () => {
  it("missing or title-only files are not filled; free text without sections is", async () => {
    assert.equal(await isMemoryFileFilled(join(makeTmp("lib-"), "nope.md")), false);
    assert.equal(await filled("# Project\n"), false);
    assert.equal(await filled("# Project\n\nWe sell shoes.\n"), true);
  });

  it("template sections (comments, empty table skeletons) are not filled", async () => {
    assert.equal(await filled("# P\n\n## Vision\n\n<!-- describe the vision -->\n\n## Stack\n"), false);
    assert.equal(await filled("# P\n\n## Glossary\n\n| Term | Definition |\n|---|---|\n|  |  |\n"), false);
  });

  it("a section with text or a table data row is filled", async () => {
    assert.equal(await filled("# P\n\n## Vision\n\nShip fast.\n"), true);
    assert.equal(await filled("# P\n\n## Glossary\n\n| Term | Definition |\n| :-- | --: |\n| API | the backend |\n"), true);
    assert.equal(await filled("# P\n\n## Notes\n\n| just a pipe line |\n"), true);
  });
});

describe("lib: running cards-sync scripts", () => {
  it("runNodeScript relays stdout and returns the exit code", () => {
    const cwd = makeTmp("lib-run-");
    assert.equal(runNodeScript("validate.mjs", [], { cwd }), 0);
    assert.notEqual(runNodeScript("no-such-script.mjs", ["--x"], { cwd }), 0);
  });

  it("runNodeScriptAsync captures stdout/stderr and the exit code", async () => {
    const cwd = makeTmp("lib-run-");
    const okRun = await runNodeScriptAsync("validate.mjs", [], { cwd });
    assert.equal(okRun.code, 0);
    assert.match(okRun.stdout, /\[validate\] No card files found/);
    const bad = await runNodeScriptAsync("no-such-script.mjs", [], { cwd });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /Cannot find module/);
  });
});

describe("lib: collectLanguageHealth", () => {
  const health = (files, opts) => collectLanguageHealth(writeFiles(makeTmp("lib-lang-"), files), opts);

  it("warns when project.yml has no locale, but not before /setup created it", async () => {
    const files = { ".github/project.yml": "version: 1\n" };
    const missing = await health(files);
    assert.equal(missing.settings.source, "default");
    assert.equal(missing.warnings.length, 1);
    assert.deepEqual((await health(files, { hasProjectYml: false })).warnings, []);
  });

  it("flags languages without any catalog and partial repo catalogs", async () => {
    const noCatalog = await health({ ".github/project.yml": "locale: ja\n" });
    assert.equal(noCatalog.warnings.length, 1);
    assert.match(noCatalog.warnings[0], /ja/);

    const partial = await health({ ".github/project.yml": "locale: fr\n", ".github/i18n/fr.json": { "lang.summary": "Langue : {primary}{extra}" } });
    assert.equal(partial.warnings.length, 1);
    assert.match(partial.warnings[0], /fr/);
  });

  it("shipped and English-variant languages are fine; extras show in the summary", async () => {
    const r = await health({ ".github/project.yml": "locale: en-GB\nlanguages: [en-GB, pt-BR, es]\n" });
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.settings.languages, ["en-GB", "pt-BR", "es"]);
    assert.match(r.summary, /pt-BR, es/);
  });
});

describe("lib: collectHyperionHealth (workspace = cwd)", () => {
  const driverDir = makeTmp("lib-driver-");
  const driver = join(driverDir, "health.mjs");
  writeFileSync(
    driver,
    `const { collectHyperionHealth } = await import(${JSON.stringify(pathToFileURL(join(hyperionDir, "lib.mjs")).href)});\n` +
      "console.log(JSON.stringify(await collectHyperionHealth()));\n"
  );
  const ghFail = makeBin({ gh: "fail" });
  const health = (cwd, env = {}) => {
    const r = runNode(driver, [], { cwd, env, binDir: ghFail });
    assert.equal(r.status, 0, r.out);
    return JSON.parse(r.stdout);
  };

  it("a complete legacy workspace has no issues or warnings", () => {
    const h = health(kitWorkspace({}, { gitRemote: true }), { PROJECT_SYNC_TOKEN: "test-token" });
    assert.deepEqual(h.issues, []);
    assert.deepEqual(h.warnings, []);
    assert.equal(h.repo, "acme/app");
    assert.equal(h.token, "test-token");
    assert.equal(h.layout, "legacy");
    assert.equal(h.memoryFilled, true);
    assert.match(h.languageSummary, /en/);
  });

  it("an empty directory reports every blocker and warning", () => {
    const h = health(makeTmp("lib-empty-"));
    assert.equal(h.issues.length, 2);
    assert.match(h.issues[0], /Missing `\.github\/`/);
    assert.match(h.issues[1], /projects-map\.json/);
    assert.equal(h.warnings.length, 5);
    assert.equal(h.repo, null);
    assert.equal(h.token, "");
  });

  it("a nested layout without the kit's .github points at kit.root", () => {
    const h = health(writeFiles(makeTmp("lib-nested-"), { ".github/project.yml": "kit:\n  root: Kit\nlocale: en\n" }), { GITHUB_TOKEN: "t" });
    assert.equal(h.layout, "nested");
    assert.match(h.issues[0], /Missing kit \.github\/ under `Kit\/`/);
    assert.equal(h.hasProjectYml, true);
  });
});
