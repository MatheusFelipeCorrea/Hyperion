import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTranslations, TRANSLATIONS_MAP } from "./docs-check.mjs";
import { splitFileMessage } from "./ci-annotate.mjs";

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
    write(root, TRANSLATIONS_MAP, {
      pairs: [
        { "pt-BR": "README.md", en: "README.en.md" },
        { "pt-BR": ".github/docs/onboarding/guia.md", en: ".github/docs/onboarding/guide-en.md" },
        { "pt-BR": ".github/docs/onboarding/missing.md", en: ".github/docs/onboarding/guide-en.md" },
        { en: "README.en.md" },
      ],
      warnUnpairedIn: [".github/docs/onboarding", ".github/docs/reference"],
      singleLanguage: [".github/docs/reference/only-en.md"],
    });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("fails on missing files and missing switcher links, warns on unpaired docs", () => {
    const { errors, warnings, pairs } = checkTranslations(root);
    assert.equal(pairs, 4);
    assert.ok(errors.some((e) => /guia\.md does not link to its en version/.test(e)));
    assert.ok(errors.some((e) => /missing\.md \(pt-BR\) is listed .* does not exist/.test(e)));
    assert.ok(!errors.some((e) => /^README/.test(e)));
    assert.deepEqual(warnings.map((w) => w.split(" ")[0]), [".github/docs/onboarding/lonely.md"]);
  });

  it("pins map-level errors to the map file, relative to the repo root", () => {
    const single = checkTranslations(root).errors.find((e) => /pair needs at least two languages/.test(e));
    assert.equal(splitFileMessage(single).file, TRANSLATIONS_MAP);

    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-docs-broken-"));
    write(broken, TRANSLATIONS_MAP, "{ not json");
    assert.equal(splitFileMessage(checkTranslations(broken).errors[0]).file, TRANSLATIONS_MAP);
    fs.rmSync(broken, { recursive: true, force: true });
  });

  it(`is a no-op without ${TRANSLATIONS_MAP}`, () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-docs-empty-"));
    assert.deepEqual(checkTranslations(empty), { errors: [], warnings: [], pairs: 0 });
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
