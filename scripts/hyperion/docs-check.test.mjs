import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkTranslations } from "./docs-check.mjs";

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

describe("checkTranslations", () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-docs-"));
    write(root, "README.md", "**English:** [README.en.md](./README.en.md)\n");
    write(root, "README.en.md", "**Português:** [README.md](./README.md)\n");
    write(root, ".github/docs/onboarding/guia.md", "No switcher here.\n");
    write(root, ".github/docs/onboarding/guide-en.md", "**Português:** [guia.md](./guia.md)\n");
    write(root, ".github/docs/onboarding/lonely.md", "x\n");
    write(root, ".github/docs/reference/only-en.md", "x\n");
    write(root, ".github/docs/translations.json", {
      pairs: [
        { "pt-BR": "README.md", en: "README.en.md" },
        { "pt-BR": ".github/docs/onboarding/guia.md", en: ".github/docs/onboarding/guide-en.md" },
        { "pt-BR": ".github/docs/onboarding/missing.md", en: ".github/docs/onboarding/guide-en.md" },
      ],
      warnUnpairedIn: [".github/docs/onboarding", ".github/docs/reference"],
      singleLanguage: [".github/docs/reference/only-en.md"],
    });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("fails on missing files and missing switcher links, warns on unpaired docs", () => {
    const { errors, warnings, pairs } = checkTranslations(root);
    assert.equal(pairs, 3);
    assert.ok(errors.some((e) => /guia\.md does not link to its en version/.test(e)));
    assert.ok(errors.some((e) => /missing\.md \(pt-BR\) is listed .* does not exist/.test(e)));
    assert.ok(!errors.some((e) => /^README/.test(e)));
    assert.deepEqual(warnings.map((w) => w.split(" ")[0]), [".github/docs/onboarding/lonely.md"]);
  });

  it("is a no-op without translations.json", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-docs-empty-"));
    assert.deepEqual(checkTranslations(empty), { errors: [], warnings: [], pairs: 0 });
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe("checkTranslations edge cases", () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-docs-edge-"));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reports invalid JSON as a single error", () => {
    write(root, ".github/docs/translations.json", "{ not json");
    const { errors, warnings, pairs } = checkTranslations(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\.github\/docs\/translations\.json: /);
    assert.deepEqual([warnings, pairs], [[], 0]);
  });

  it("rejects single-language pairs and tolerates a missing pairs array / unpaired dir", () => {
    write(root, ".github/docs/translations.json", { pairs: [{ en: "a.md" }, null], warnUnpairedIn: ["nope/"] });
    const { errors, pairs } = checkTranslations(root);
    assert.equal(pairs, 2);
    assert.equal(errors.length, 2);
    assert.ok(errors.every((e) => /pair needs at least two languages/.test(e)));

    write(root, ".github/docs/translations.json", { pairs: "nope" });
    assert.deepEqual(checkTranslations(root), { errors: [], warnings: [], pairs: 0 });
  });
});

describe("docs-check CLI --root", () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "docs-check.mjs");
  const run = (root) => spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  const roots = [];
  const makeRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-docs-cli-"));
    roots.push(root);
    return root;
  };
  after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

  it("passes, ignoring external/anchor/placeholder links, node_modules and .git; prints unpaired warnings", () => {
    const root = makeRoot();
    write(
      root,
      "README.md",
      "[web](https://x.dev) [mail](mailto:a@b.c) [top](#top) [ph](url) [sha](../commit/abc1234) [ok](./docs/guide.md#intro) [en](./README.en.md)\n"
    );
    write(root, "README.en.md", "[pt](./README.md)\n");
    write(root, "docs/guide.md", "# Guide\n");
    write(root, "docs/deep/rule.mdc", "[up](../guide.md)\n");
    write(root, "docs/plain.txt", "[broken](./nowhere.md)\n");
    write(root, "node_modules/pkg/README.md", "[broken](./nowhere.md)\n");
    write(root, ".git/notes.md", "[broken](./nowhere.md)\n");
    write(root, ".github/docs/translations.json", {
      pairs: [{ "pt-BR": "README.md", en: "README.en.md" }],
      warnUnpairedIn: ["docs"],
    });
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /docs:check OK — 4 files, 1 translated pair\(s\)/);
    assert.match(r.stderr, /warn: docs\/guide\.md has no translation/);
    assert.doesNotMatch(r.stderr, /rule\.mdc/);
  });

  it("fails on broken local links", () => {
    const root = makeRoot();
    write(root, "README.md", "[gone](./missing.md) [also](sub/none.md#x)\n");
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Broken links: 2/);
    assert.match(r.stderr, /README\.md → \.\/missing\.md/);
    assert.match(r.stderr, /README\.md → sub\/none\.md#x/);
  });

  it("fails on translation pair problems once links are fine", () => {
    const root = makeRoot();
    write(root, "guia.md", "Sem link.\n");
    write(root, "guide.md", "[pt](./guia.md)\n");
    write(root, ".github/docs/translations.json", { pairs: [{ "pt-BR": "guia.md", en: "guide.md" }] });
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Translation pairs: 1 problem\(s\)/);
    assert.match(r.stderr, /guia\.md does not link to its en version guide\.md/);
  });
});
