import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "review-verify.mjs");

describe("review-verify", () => {
  it("passes with required sections", () => {
    const dir = mkdtempSync(join(tmpdir(), "rv-ok-"));
    try {
      const file = join(dir, "pr-1-review.md");
      writeFileSync(
        file,
        `---
pr: 1
verdict: APPROVE
tests_ran: yes
review_date: 2026-08-21
---

# PR Review

## Summary
Looks good.

## Findings
None.

## Test output
npm test — pass
`
      );
      const r = spawnSync(process.execPath, [script, "--review", file, "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /review-verify OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts translated headings with card emojis", () => {
    const dir = mkdtempSync(join(tmpdir(), "rv-emoji-"));
    try {
      const file = join(dir, "pr-3-review.md");
      writeFileSync(
        file,
        `---
pr: 3
verdict: APPROVE
tests_ran: yes
review_date: 2026-10-08
---

## 📋 Resumo
Ok.

## 🔍 Achados
Nenhum.

## ✅ Saída dos testes
npm test — pass
`
      );
      const r = spawnSync(process.execPath, [script, "--review", file, "--root", dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails without tests_ran", () => {
    const dir = mkdtempSync(join(tmpdir(), "rv-bad-"));
    try {
      const file = join(dir, "pr-2-review.md");
      writeFileSync(
        file,
        `---
verdict: COMMENT
---
## Summary
x
## Findings
y
`
      );
      const r = spawnSync(process.execPath, [script, "--review", file, "--root", dir], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review-verify CLI branches", () => {
  const env = { ...process.env, HYPERION_TELEMETRY: "false" };
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  let dir;
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    return join(dir, rel);
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "rv-cli-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:[\s\S]*--latest \[--root <repo-root>\]/);
  });

  it("--latest --root picks the last review by name; body-only fields are accepted", () => {
    write("repo/.github/plans/reviews/pr-1-review.md", "garbage\n");
    write(
      "repo/.github/plans/reviews/pr-2-review.md",
      "# Review\nverdict: request_changes\n\n## Summary\nx\n\n## Findings\ny\n\n- tests_ran: skipped\n"
    );
    write("repo/.github/plans/reviews/.draft.md", "x");
    const r = run(["--latest", "--root", join(dir, "repo")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK verdict: request_changes/);
    assert.match(r.stdout, /OK tests_ran: skipped/);
    assert.doesNotMatch(r.stderr, /WARN/);
  });

  it("fails with usage when no review can be found", () => {
    write("empty/.github/plans/reviews/.gitkeep", "");
    for (const root of [join(dir, "empty"), join(dir, "nothing")]) {
      const r = run(["--root", root]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /No review specified and none under \.github\/plans\/reviews\//);
      assert.match(r.stdout, /Usage:/);
    }
  });

  it("fails when the review file does not exist", () => {
    const r = run(["--review", join(dir, "missing.md")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Review not found: /);
  });

  it("reports a bad verdict, missing headings (with translated alternatives) and bad tests_ran", () => {
    const file = write("bad.md", "---\nverdict: MAYBE\ntests_ran: often\n---\n## Notes\n");
    const r = run(["--review", file]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL verdict: got "MAYBE"/);
    assert.match(r.stderr, /FAIL: missing ## Summary \(or .*Resumo/);
    assert.match(r.stderr, /FAIL: missing ## Findings \(or .*Achados/);
    assert.match(r.stderr, /FAIL tests_ran: got "often"/);
    assert.match(r.stderr, /review-verify FAILED \(4\)/);

    const empty = run(["--review", write("empty.md", "nothing here\n")]);
    assert.match(empty.stderr, /FAIL verdict: got "\(missing\)"/);
    assert.match(empty.stderr, /FAIL tests_ran: got "\(missing\)"/);
  });

  it("warns when tests_ran=yes but there is no Test output section", () => {
    const file = write("warn.md", "verdict: COMMENT\ntests_ran: yes\n\n## Summary\nx\n\n## Findings\ny\n");
    const r = run(["--review", file]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /WARN: tests_ran=yes but no ## Test output section/);
  });
});
