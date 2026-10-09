import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "skills-catalog.mjs");

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("skills-catalog --root", () => {
  let root;
  const outPt = () => join(root, ".github/docs/reference/catalogo-skills.md");
  const outEn = () => join(root, ".github/docs/reference/skills-catalog.md");

  before(() => {
    root = mkdtempSync(join(tmpdir(), "hyperion-skills-catalog-"));
    const write = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    write(
      ".github/commands.yml",
      `commands:
  - phrase: "/spec"
    skill: "spec-writer"
    description: "write a spec"
  - phrase: "/spec-again"
    skill: "spec-writer"
    description: "alias"
  - phrase: "/help"
    skill: null
    npm: "hyperion:help"
    description: "List shortcuts"
`
    );
    write(
      ".github/skills/catalog-meta.json",
      JSON.stringify({
        "spec-writer": { phase: "plan", when_pt: "Escrever spec", when_en: "Write a spec", output: "`specs/`" },
        "b-reviewer": { phase: "quality", when_pt: "Revisar", when_en: "Review", output: "*(chat)*" },
        "a-auditor": { phase: "quality", when_pt: "Auditar", when_en: "Audit", output: "`audits/`" },
        orphan: { phase: "not-a-phase", when_pt: "x", when_en: "x", output: "x" },
      })
    );
    write(".github/skills/planning/spec-writer/SKILL.md", "---\nname: spec-writer\ndescription: Specs\n---\n");
    write(".github/skills/quality/b-reviewer/SKILL.md", "---\nname: b-reviewer\ndescription: Review\n---\n");
    mkdirSync(join(root, ".github/docs/reference"), { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("write mode renders pt + en catalogs under the given root", () => {
    const r = run(["--root", root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /skills-catalog OK → .*catalogo-skills\.md/);
    assert.match(r.stdout, /skills-catalog OK → .*skills-catalog\.md/);

    const pt = readFileSync(outPt(), "utf8");
    assert.match(pt, /^# 🧩 Catálogo de skills Hyperion/);
    assert.match(pt, /badge\/skills-4-/);
    assert.match(pt, /badge\/áreas-5-/);
    assert.match(pt, /## 📋 Planejamento/);
    assert.match(pt, /\| \*\*spec-writer\*\* \| `\/spec` \| Escrever spec \| `specs\/` \| \[SKILL\.md\]\(\.\.\/\.\.\/skills\/planning\/spec-writer\/SKILL\.md\) \|/);
    assert.doesNotMatch(pt, /🧭 Bootstrap\n/);
    assert.doesNotMatch(pt, /orphan/);
    assert.ok(pt.indexOf("**a-auditor**") < pt.indexOf("**b-reviewer**"));
    assert.match(pt, /\| \*\*a-auditor\*\* \| `—` \| Auditar \| `audits\/` \| \[SKILL\.md\]\(\.\.\/\.\.\/skills\/\*\*\/a-auditor\/SKILL\.md\) \|/);
    assert.match(pt, /## 🤖 Agents \(fluxos longos\)/);
    assert.match(pt, /\| \*\*release\*\* \| `\/release` \| Changelog, tag, release \|/);

    const en = readFileSync(outEn(), "utf8");
    assert.match(en, /^# 🧩 Hyperion skills catalog/);
    assert.doesNotMatch(en, /áreas/);
    assert.match(en, /## 📋 Planning/);
    assert.match(en, /## 🔍 Quality/);
    assert.match(en, /\| \*\*spec-writer\*\* \| `\/spec` \| Write a spec \|/);
    assert.match(en, /## 🤖 Agents \(long flows\)/);
    assert.match(en, /\| \*\*mentoring\*\* \| `\/mentor` \| Socratic teaching \|/);
  });

  it("--check passes when both catalogs are in sync", () => {
    const r = run(["--check", "--root", root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /skills-catalog OK \(in sync\)/);
  });

  it("--check fails (without writing) when a catalog drifted", () => {
    writeFileSync(outEn(), "# hand edited\n");
    const r = run(["--check", "--root", root]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /skills-catalog out of date/);
    assert.equal(readFileSync(outEn(), "utf8"), "# hand edited\n");
    assert.ok(existsSync(outPt()));
  });
});
