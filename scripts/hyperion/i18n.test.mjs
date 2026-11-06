import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHIPPED_LANGUAGES,
  applyLanguageConfig,
  clearCatalogCache,
  fallbackChain,
  hasCatalog,
  keyVariants,
  languageName,
  languageSettingsFrom,
  languagesFor,
  missingKeys,
  multiRender,
  normalizeTag,
  parseLanguageConfig,
  resolveLanguages,
  t,
  tShell,
  translator,
  validateLanguageConfig,
} from "./i18n.mjs";
import { detectRepoLanguage, scoreLanguage } from "./detect-language.mjs";

const catalogDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "i18n");
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("catalogs", () => {
  const en = JSON.parse(fs.readFileSync(path.join(catalogDir, "en.json"), "utf8"));
  for (const tag of SHIPPED_LANGUAGES.filter((l) => l !== "en")) {
    it(`${tag} has every en key with the same placeholders`, () => {
      const cat = JSON.parse(fs.readFileSync(path.join(catalogDir, `${tag}.json`), "utf8"));
      assert.deepEqual(Object.keys(cat).sort(), Object.keys(en).sort());
      for (const key of Object.keys(en)) assert.deepEqual(placeholders(cat[key]), placeholders(en[key]), `${tag}:${key}`);
    });
  }
});

describe("tags and fallback", () => {
  it("normalizes tags", () => {
    assert.equal(normalizeTag("pt_br"), "pt-BR");
    assert.equal(normalizeTag("EN"), "en");
    assert.equal(normalizeTag("zh-hant-tw"), "zh-Hant-TW");
    assert.equal(normalizeTag("not a tag"), null);
  });

  it("falls back exact → base → shipped same base → en", () => {
    assert.deepEqual(fallbackChain("pt-PT"), ["pt-PT", "pt", "pt-BR", "en"]);
    assert.deepEqual(fallbackChain("es-MX"), ["es-MX", "es", "en"]);
    assert.deepEqual(fallbackChain("fr"), ["fr", "en"]);
    assert.equal(t("coverage.heading", {}, "pt-PT"), "Cobertura");
    assert.equal(t("coverage.heading", {}, "fr"), "Coverage");
    assert.equal(t("no.such.key", {}, "es"), "no.such.key");
  });

  it("interpolates and names languages", () => {
    assert.equal(t("ci.prSize.info", { total: 10, max: 5 }, "es"), "Líneas modificadas: 10 (máx. 5)");
    assert.equal(languageName("en"), "English");
    assert.match(languageName("pt-BR"), /^Português/);
  });

  it("tShell escapes the template but keeps raw shell fragments", () => {
    const s = tShell("ci.branchName.error", { branch: "$PR_BRANCH", pattern: "$PATTERN" }, "en");
    assert.equal(s, "'$PR_BRANCH' does not match $PATTERN");
    const withQuote = tShell("coverage.metricFallback", { metric: "$M", format: "x", used: "y" }, "en");
    assert.equal(withQuote, 'metric \\"$M\\" not available in x; using \\"y\\"');
  });
});

describe("project.yml language config", () => {
  it("parses flow and block lists without a YAML library", () => {
    assert.deepEqual(parseLanguageConfig("locale: pt-BR\nlanguages: [pt-BR, en]\ni18n:\n  multilingual: [pr, docs]\n"), {
      locale: "pt-BR",
      languages: ["pt-BR", "en"],
      multilingual: ["pr", "docs"],
    });
    assert.deepEqual(parseLanguageConfig("locale: es\nlanguages:\n  - es\n  - en\ni18n:\n  multilingual:\n    - pr\nname: x\n"), {
      locale: "es",
      languages: ["es", "en"],
      multilingual: ["pr"],
    });
  });

  it("builds settings with defaults and fallbacks", () => {
    assert.deepEqual(languageSettingsFrom("locale: pt-BR\n"), { primary: "pt-BR", languages: ["pt-BR"], multilingual: ["pr", "comments", "release"], source: "project.yml" });
    assert.equal(languageSettingsFrom("", { fallbackLocale: "es" }).primary, "es");
    assert.equal(languageSettingsFrom("").primary, "en");
  });

  it("validates primary-first and surfaces", () => {
    assert.deepEqual(validateLanguageConfig("locale: pt-BR\nlanguages: [en, pt-BR]\n").errors, ["languages[0] (en) must equal locale (pt-BR)"]);
    assert.match(validateLanguageConfig("locale: en\ni18n:\n  multilingual: [chat]\n").errors[0], /unknown surface "chat"/);
    assert.match(validateLanguageConfig("name: x\n").warnings[0], /locale is not set/);
  });

  it("writes locale/languages into project.yml text, keeping the rest", () => {
    assert.equal(applyLanguageConfig("version: 1\nname: x\n", { locale: "pt_br" }), "version: 1\nlocale: pt-BR\nname: x\n");
    assert.equal(
      applyLanguageConfig("version: 1\nlocale: en\nlanguages:\n  - en\n  - es\nname: x\n", { languages: ["pt-BR", "en"] }),
      "version: 1\nlocale: pt-BR\nlanguages: [pt-BR, en]\nname: x\n"
    );
    assert.equal(applyLanguageConfig("locale: es\nlanguages: [es, en]\n", { locale: "es" }), "locale: es\n");
    assert.throws(() => applyLanguageConfig("x: 1\n", {}), /locale or languages required/);
  });

  it("renders multilingual only for enabled surfaces", () => {
    const s = languageSettingsFrom("locale: pt-BR\nlanguages: [pt-BR, en]\n");
    assert.deepEqual(languagesFor(s, "pr"), ["pt-BR", "en"]);
    assert.deepEqual(languagesFor(s, "issues"), ["pt-BR"]);
    const out = multiRender((l) => t("coverage.heading", {}, l), languagesFor(s, "comments"));
    assert.equal(out, "Cobertura\n\n<details><summary>English</summary>\n\nCoverage\n\n</details>\n");
    const tr = translator(s);
    assert.equal(tr.t("coverage.heading"), "Cobertura");
    assert.equal(tr.multi("issues", (l) => tr.tIn(l, "coverage.heading")), "Cobertura\n");
  });
});

describe("repo override + resolveLanguages", () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-i18n-"));
    fs.mkdirSync(path.join(root, ".github", "i18n"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github", "project.yml"), "version: 1\nlocale: fr\nlanguages: [fr, en]\n");
    fs.writeFileSync(path.join(root, ".github", "i18n", "fr.json"), JSON.stringify({ "coverage.heading": "Couverture" }));
    fs.writeFileSync(path.join(root, "README.md"), "Ceci est le projet. Pour utiliser, vous devez ajouter la configuration dans le dossier avec les options.");
  });
  after(() => {
    clearCatalogCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads project.yml and merges the repo catalog", () => {
    const s = resolveLanguages(root);
    assert.equal(s.primary, "fr");
    assert.deepEqual(s.languages, ["fr", "en"]);
    assert.equal(t("coverage.heading", {}, "fr", { root }), "Couverture");
    assert.equal(t("coverage.diff.heading", {}, "fr", { root }), "Changed lines");
    assert.ok(missingKeys("fr", { root }).includes("coverage.diff.heading"));
    assert.ok(!missingKeys("fr", { root }).includes("coverage.heading"));
    assert.equal(hasCatalog("fr", { root }), true);
    assert.equal(hasCatalog("de", { root }), false);
    assert.equal(hasCatalog("pt-PT"), true);
  });

  it("lists every translation of a key, including repo override languages", () => {
    fs.writeFileSync(path.join(root, ".github", "i18n", "fr.json"), JSON.stringify({ "coverage.heading": "Couverture", "review.summary": "Résumé" }));
    clearCatalogCache();
    assert.deepEqual(keyVariants("review.summary", { root }), ["Summary", "Resumo", "Resumen", "Résumé"]);
  });

  it("detects the README language", () => {
    assert.equal(detectRepoLanguage(root, { gh: false }).suggestion, "fr");
  });
});

describe("scoreLanguage", () => {
  it("tells pt, es and en apart", () => {
    assert.equal(scoreLanguage("Corrige o login quando o usuário não tem sessão e também ajusta a validação dos campos").language, "pt-BR");
    assert.equal(scoreLanguage("Corrige el inicio de sesión cuando el usuario no tiene sesión y también la validación").language, "es");
    assert.equal(scoreLanguage("Fix the login when the user has no session and update the validation of the form").language, "en");
    assert.equal(scoreLanguage("x").language, null);
  });
});
