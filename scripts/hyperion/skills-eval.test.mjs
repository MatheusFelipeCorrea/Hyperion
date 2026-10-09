import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "skills-eval.mjs");

function withKit(cases, fn) {
  const root = mkdtempSync(join(tmpdir(), "hyperion-skills-eval-"));
  try {
    const write = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    write(".github/skills/planning/alpha/SKILL.md", "---\nname: alpha\n---\n## Output\nWrites `plans/alpha.md`.\n");
    write(".github/skills/planning/alpha/notes.md", "ignored");
    write(".github/skills/eval/shadow/SKILL.md", "inside eval/ — never indexed\n");
    write("docs/guide.md", "# Guide\nRun /alpha first.\n");
    write(".github/skills/eval/cases.json", JSON.stringify(cases));
    return fn(spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("skills-eval --root", () => {
  it("passes when every skill/file case matches", () => {
    withKit(
      [
        { skill: "alpha", mustContain: ["## Output"], mustMatch: ["^Writes `plans/"] },
        { file: "docs/guide.md", mustContain: ["/alpha"] },
        { skill: "alpha" },
      ],
      (r) => {
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /skills:eval OK \(3 cases\)/);
      }
    );
  });

  it("counts every failing check: missing targets, needles, patterns and invalid regexes", () => {
    withKit(
      [
        { skill: "shadow", mustContain: ["x"] },
        { file: "docs/missing.md" },
        { mustContain: ["x"] },
        { skill: "alpha", mustContain: ["## Output", "## Nope"], mustMatch: ["^## Steps", "(unclosed"] },
      ],
      (r) => {
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /FAIL shadow: target not found/);
        assert.match(r.stderr, /FAIL docs\/missing\.md: target not found/);
        assert.match(r.stderr, /FAIL \(unknown\): target not found/);
        assert.match(r.stderr, /FAIL alpha: missing "## Nope"/);
        assert.match(r.stderr, /FAIL alpha: mustMatch \/\^## Steps\//);
        assert.match(r.stderr, /FAIL alpha: invalid mustMatch \/\(unclosed\/ \(/);
        assert.match(r.stderr, /skills:eval FAILED \(6 checks\)/);
      }
    );
  });
});
