import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { detectRepoLanguage, scoreLanguage } from "./detect-language.mjs";
import { cleanupTmp, gitCommitAll, hyperionDir, makeBin, makeTmp, runNode, writeFiles } from "./test-support/cli-harness.mjs";

const cli = join(hyperionDir, "detect-language.mjs");

const README_PT = "# Projeto\n\nEste projeto é uma ferramenta para você organizar os cards, também com integração. Não é complicado: a configuração está pronta e as instruções são claras.\n";
const PR_ES = "Añade la validación de los usuarios para el módulo\nCorrige la conexión con el servidor de la aplicación\n";

let repo;

before(() => {
  repo = writeFiles(makeTmp("detect-lang-"), {
    "README.md": README_PT,
    // `gh pr list ...` runs this file when gh is the fake node-backed gh (see makeBin).
    pr: `process.stdout.write(${JSON.stringify(PR_ES)});\n`,
  });
  gitCommitAll(repo, "fix the parser and update the docs for the release with the new flag");
});

after(cleanupTmp);

describe("detect-language", () => {
  it("scoreLanguage needs a minimum signal and strips code, links and commit prefixes", () => {
    assert.deepEqual(scoreLanguage("").language, null);
    assert.equal(scoreLanguage("feat(api): `the and is` https://the.example/and").language, null);
    const r = scoreLanguage("Ich bin für die Änderung und das ist nicht schön, weil es größer ist");
    assert.equal(r.language, "de");
    assert.ok(r.confidence > 0.5);
  });

  it("detectRepoLanguage weighs README, commits and (optionally) PR titles", () => {
    const r = detectRepoLanguage(repo, { gh: false });
    assert.equal(r.sources.readme.language, "pt-BR");
    assert.equal(r.sources.commits.language, "en");
    assert.equal(r.sources.prs, undefined);
    assert.equal(r.suggestion, "en", "commits weigh twice the README");
    assert.deepEqual(r.alsoSeen, ["pt-BR"]);
  });

  it("falls back to en with zero confidence when there is no text at all", () => {
    const r = detectRepoLanguage(makeTmp("detect-empty-"), { gh: false });
    assert.deepEqual(r, { suggestion: "en", confidence: 0, sources: {}, alsoSeen: [] });
  });

  it("CLI prints the suggestion, per-source detail and the languages hint (PR titles via gh)", () => {
    const r = runNode(cli, [], { cwd: repo, binDir: makeBin({ gh: "node" }) });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Suggested language: \S+ \(confidence [\d.]+\)/);
    assert.match(r.stdout, /readme {3}pt-BR/);
    assert.match(r.stdout, /commits {2}en/);
    assert.match(r.stdout, /prs {6}es/);
    assert.match(r.stdout, /also seen: .* — consider languages: \[/);
  });

  it("CLI --json works without gh, git or a README", () => {
    const r = runNode(cli, ["--json"], { cwd: makeTmp("detect-empty-"), binDir: makeBin({ gh: "fail" }) });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), { suggestion: "en", confidence: 0, sources: {}, alsoSeen: [] });
  });

  it("CLI --no-gh skips PR titles and prints no hint for a single language", () => {
    const root = writeFiles(makeTmp("detect-docs-"), { "docs/README.md": "This is the guide for the tool and how to use it with the team.\n" });
    const r = runNode(cli, ["--no-gh"], { cwd: root });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Suggested language: en \(confidence 1\)/);
    assert.match(r.stdout, /readme {3}en/);
    assert.doesNotMatch(r.stdout, /also seen/);
  });

  it("an unscorable source shows as ?", () => {
    const root = writeFiles(makeTmp("detect-short-"), { README: "Hi\n" });
    const r = runNode(cli, ["--no-gh"], { cwd: root });
    assert.match(r.stdout, /readme {3}\? \(0\)/);
  });
});
