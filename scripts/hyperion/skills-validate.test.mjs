import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "skills-validate.mjs");

function withKit(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "hyperion-skills-validate-"));
  try {
    mkdirSync(join(root, ".github/skills"), { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return fn(spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const skill = (name, body = "## Output\nA file.\n", extra = "") =>
  `---\nname: ${name}\ndescription: Does ${name}${extra}\n---\n\n${body}`;

describe("skills-validate --root", () => {
  it("passes valid skills (BOM, folded description, quoted name, ops skill without Output)", () => {
    withKit(
      {
        ".github/skills/planning/alpha/SKILL.md": `\uFEFF${skill("alpha")}`,
        ".github/skills/planning/beta/SKILL.md": `---\r\nname: "beta"\r\ndescription: >-\r\n  Folded\r\n  description\r\n---\r\n## Output (files)\r\n`,
        ".github/skills/setup/hyperion-ops/SKILL.md": "---\nname: hyperion-ops\ndescription: ops\n---\nNo output section.\n",
        ".github/skills/planning/alpha/notes.md": "not a skill",
      },
      (r) => {
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /skills:validate OK \(3 skills\)/);
      }
    );
  });

  it("reports every structural problem", () => {
    withKit(
      {
        ".github/skills/a/no-frontmatter/SKILL.md": "# just a heading\n",
        ".github/skills/a/unclosed/SKILL.md": "---\nname: unclosed\n",
        ".github/skills/a/no-name/SKILL.md": "---\ndescription: d\n---\n## Output\n",
        ".github/skills/a/no-desc/SKILL.md": "---\nname: no-desc\ndescription: >-\n---\n## Output\n",
        ".github/skills/a/mismatch/SKILL.md": skill("other-name"),
        ".github/skills/a/no-output/SKILL.md": skill("no-output", "## Steps\n"),
        ".github/skills/a/fixed-lang/SKILL.md": skill("fixed-lang", "## Output\nWrite in pt-BR|en.\n"),
        ".github/skills/a/fixed-var/SKILL.md": skill("fixed-var", '## Output\n${OUTPUT_LANGUAGE="pt-BR"}\n'),
        ".github/skills/a/dup/SKILL.md": skill("dup"),
        ".github/skills/b/dup/SKILL.md": skill("dup"),
      },
      (r) => {
        assert.equal(r.status, 1, r.stdout + r.stderr);
        const err = r.stderr.replace(/\\/g, "/");
        assert.match(err, /skills:validate failed/);
        assert.match(err, /\.github\/skills\/a\/no-frontmatter\/SKILL\.md: missing YAML frontmatter/);
        assert.match(err, /\.github\/skills\/a\/unclosed\/SKILL\.md: missing YAML frontmatter/);
        assert.match(err, /no-name\/SKILL\.md: frontmatter missing 'name'/);
        assert.match(err, /no-desc\/SKILL\.md: frontmatter missing 'description'/);
        assert.match(err, /mismatch\/SKILL\.md: frontmatter name "other-name" does not match folder "mismatch"/);
        assert.match(err, /no-output\/SKILL\.md: missing "## Output" section/);
        assert.match(err, /fixed-lang\/SKILL\.md: fixed language choice "pt-BR\|en"/);
        assert.match(err, /fixed-var\/SKILL\.md: fixed language choice "\$\{OUTPUT_LANGUAGE="/);
        const dup = err.split("\n").find((l) => l.includes('Duplicate skill name "dup"')) || "";
        assert.ok(dup.includes(".github/skills/a/dup/SKILL.md") && dup.includes(".github/skills/b/dup/SKILL.md"), err);
      }
    );
  });
});
