import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "docs-prose-check.mjs");

// Stale phrases are assembled at runtime so this file never trips the real check.
const staleCopilot = [".github", "instructions", "copilot-instructions.md"].join("/");
const staleExemplars = [".github", "docs", "exemplars.md"].join("/");
const staleForwardOnly = ["Linear", "is", "forward-only"].join(" ");

function withTree(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "hyperion-prose-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return fn(spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("docs-prose-check --root", () => {
  it("passes a clean tree and ignores skipped dirs, CHANGELOG.md and non-doc extensions", () => {
    withTree(
      {
        "README.md": "# Clean\n",
        ".github/config.yml": "a: 1\n",
        "node_modules/pkg/README.md": `see ${staleCopilot}\n`,
        "CHANGELOG.md": `moved ${staleExemplars}\n`,
        "notes.txt": `see ${staleCopilot}\n`,
      },
      (r) => {
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /docs:prose-check OK — 2 files, 5 rules/);
      }
    );
  });

  it("reports each stale reference once per file and rule", () => {
    withTree(
      {
        "docs/a.md": `see ${staleCopilot} and again ${staleCopilot}\n`,
        "docs/b.mdc": `${staleExemplars}\n`,
        "docs/c.json": JSON.stringify({ note: staleForwardOnly }),
        "docs/d.md": `${staleCopilot}\n${staleExemplars}\n`,
      },
      (r) => {
        assert.equal(r.status, 1, r.stdout + r.stderr);
        const err = r.stderr.replace(/\\/g, "/");
        assert.match(err, /docs:prose-check FAILED — 5 stale reference\(s\)/);
        assert.match(err, /docs\/a\.md: Copilot instructions moved/);
        assert.match(err, /docs\/b\.mdc: exemplars moved/);
        assert.match(err, /docs\/c\.json: Linear supports reverse sync/);
        assert.match(err, /docs\/d\.md: exemplars moved/);
      }
    );
  });

  it("skips multi-segment entries like audits/results by path, not by folder name", () => {
    withTree(
      {
        ".github/audits/results/report.md": `see ${staleCopilot}\n`,
        ".github/audits/prompts/security.md": `see ${staleExemplars}\n`,
        "results/notes.md": `see ${staleCopilot}\n`,
      },
      (r) => {
        assert.equal(r.status, 1, r.stdout + r.stderr);
        const err = r.stderr.replace(/\\/g, "/");
        assert.match(err, /docs:prose-check FAILED — 2 stale reference\(s\)/);
        assert.match(err, /^  \.github\/audits\/prompts\/security\.md: exemplars moved/m);
        assert.match(err, /^  results\/notes\.md: Copilot instructions moved/m);
        assert.doesNotMatch(err, /audits\/results/);
      }
    );
  });
});
