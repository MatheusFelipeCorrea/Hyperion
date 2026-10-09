import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "project-verify.mjs");

describe("project-verify", () => {
  it("passes on valid project.yml with existing paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-ok-"));
    try {
      mkdirSync(join(dir, ".github"), { recursive: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "package.json"), "{}\n");
      writeFileSync(
        join(dir, ".github", "project.yml"),
        `version: 1
name: Demo
commands:
  test: npm test
apps:
  api:
    root: src
    manifest: package.json
uncertainties:
  - none
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /project-verify OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates against project.schema.json when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-schema-"));
    try {
      mkdirSync(join(dir, ".github"), { recursive: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "package.json"), "{}\n");
      const schemaSrc = join(__dirname, "..", "..", ".github", "project.schema.json");
      writeFileSync(join(dir, ".github", "project.schema.json"), readFileSync(schemaSrc, "utf8"));
      writeFileSync(
        join(dir, ".github", "project.yml"),
        `version: 1
name: Demo
commands:
  test: npm test
apps:
  api:
    root: src
    manifest: package.json
docs:
  requirements: null
uncertainties:
  - none
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /OK schema: project\.yml matches project\.schema\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when project.yml violates project.schema.json (unknown top-level key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-schema-bad-"));
    try {
      mkdirSync(join(dir, ".github"), { recursive: true });
      const schemaSrc = join(__dirname, "..", "..", ".github", "project.schema.json");
      writeFileSync(join(dir, ".github", "project.schema.json"), readFileSync(schemaSrc, "utf8"));
      writeFileSync(
        join(dir, ".github", "project.yml"),
        `version: 1
name: Demo
this_key_does_not_exist_in_schema: true
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /FAIL schema:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when app root missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-bad-"));
    try {
      mkdirSync(join(dir, ".github"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "project.yml"),
        `version: 1
name: Demo
apps:
  api:
    root: missing-app
`
      );
      const r = spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project-verify CLI branches", () => {
  const schemaSrc = join(__dirname, "..", "..", ".github", "project.schema.json");
  let dir;
  let n = 0;
  const run = (root, extra = []) => spawnSync(process.execPath, [...extra, script, "--root", root], { encoding: "utf8" });
  /** Fresh repo root; files: { rel: text }, `null` text → directory. */
  const repo = (files) => {
    const root = join(dir, `r${n++}`);
    mkdirSync(join(root, ".github"), { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(root, rel);
      if (text === null) {
        mkdirSync(abs, { recursive: true });
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    return root;
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pv-cli-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--help prints usage and exits 0", () => {
    const r = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:[\s\S]*--root <repo-root>/);
  });

  it("fails when .github/project.yml is missing", () => {
    const r = run(repo({}));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAIL: missing \.github\/project\.yml/);
  });

  it("reports bad version, missing name, language errors and every warning", () => {
    const root = repo({
      ".github/project.yml": "version: one\nlocale: pt-BR\nlanguages: [en, pt-BR]\ni18n:\n  multilingual: [pr, tweets]\n",
    });
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /WARN: no \.github\/project\.schema\.json found/);
    assert.match(r.stderr, /FAIL: project\.yml must have integer `version:`/);
    assert.match(r.stderr, /FAIL: project\.yml must have `name:`/);
    assert.match(r.stderr, /WARN: no commands\.test/);
    assert.match(r.stderr, /FAIL language: languages\[0\] \(en\) must equal locale \(pt-BR\)/);
    assert.match(r.stderr, /FAIL language: i18n\.multilingual: unknown surface "tweets"/);
    assert.match(r.stderr, /WARN: no uncertainties:/);
    assert.match(r.stdout, /OK language: pt-BR \+ en/);
  });

  it("warns about a locale without a message catalog and a missing locale", () => {
    const withTag = run(repo({ ".github/project.yml": "version: 1\nname: x\nlocale: xx-YY\nuncertainties: []\n" }));
    assert.equal(withTag.status, 0, withTag.stdout + withTag.stderr);
    assert.match(withTag.stdout, /OK language: xx-YY$/m);
    assert.match(withTag.stderr, /WARN: no message catalog for xx-YY/);

    const noLocale = run(repo({ ".github/project.yml": "version: 1\nname: x\nuncertainties: []\n" }));
    assert.equal(noLocale.status, 0, noLocale.stdout + noLocale.stderr);
    assert.match(noLocale.stderr, /WARN: locale is not set/);
  });

  it("checks apps root/manifest/source_dirs and docs paths", () => {
    const root = repo({
      "apps/web": null,
      "apps/web/src": null,
      "apps/web/package.json": "{}",
      "docs/requirements.md": "# req",
      ".github/project.yml": [
        "version: 1",
        "name: x",
        "apps:",
        "  web:",
        "    root: ./apps/web",
        "    manifest: \"apps/web/package.json\"",
        "    source_dirs:",
        "      - apps/web/src",
        "      - apps/web/gone",
        "    language: ts",
        "  api:",
        "    root: apps/api",
        "    source_dirs:",
        "      - apps/api/src",
        "  tool:",
        "    root: null",
        "uncertainties: []",
        "docs:",
        "  requirements: docs/requirements.md",
        "",
      ].join("\n"),
    });
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /OK apps\.web\.root: \.\/apps\/web\//);
    assert.match(r.stdout, /OK apps\.web\.manifest: apps\/web\/package\.json$/m);
    assert.match(r.stdout, /OK apps\.web\.source_dirs: apps\/web\/src\//);
    assert.match(r.stderr, /FAIL apps\.web\.source_dirs: path missing → apps\/web\/gone/);
    assert.match(r.stderr, /FAIL apps\.api\.root: path missing → apps\/api/);
    assert.match(r.stderr, /FAIL apps\.api\.source_dirs: path missing → apps\/api\/src/);
    assert.match(r.stdout, /OK apps\.tool\.root: null$/m);
    assert.match(r.stdout, /OK docs\.requirements: docs\/requirements\.md$/m);
  });

  it("fails when a docs path is missing", () => {
    const r = run(repo({ ".github/project.yml": "version: 1\nname: x\nuncertainties: []\ndocs:\n  adr: docs/adr\n" }));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL docs\.adr: path missing → docs\/adr/);
  });

  it("reports YAML parse errors when the schema is present", () => {
    const root = repo({
      ".github/project.schema.json": readFileSync(schemaSrc, "utf8"),
      ".github/project.yml": "version: 1\nname: [unclosed\n",
    });
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL schema: YAML parse error: /);
  });

  it("explains how to fix missing ajv/js-yaml instead of crashing", () => {
    const hooks = join(dir, "hooks.mjs");
    const register = join(dir, "register.mjs");
    writeFileSync(
      hooks,
      `export async function resolve(specifier, context, next) {
         if (specifier === "ajv/dist/2020.js") throw new Error("Cannot find package 'ajv'");
         return next(specifier, context);
       }`
    );
    writeFileSync(register, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
    const root = repo({
      ".github/project.schema.json": readFileSync(schemaSrc, "utf8"),
      ".github/project.yml": "version: 1\nname: x\n",
    });
    const r = run(root, ["--import", pathToFileURL(register).href]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL schema: dependencies not installed — run "npm install"/);
  });

  it("turns unexpected errors into a single FAIL line", () => {
    const root = repo({ ".github/project.yml": null });
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^FAIL: unexpected error — /m);
  });
});
