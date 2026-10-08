import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
      const r = spawnSync(process.execPath, [script, "--review", file], { encoding: "utf8" });
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
      const r = spawnSync(process.execPath, [script, "--review", file], { encoding: "utf8" });
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
      const r = spawnSync(process.execPath, [script, "--review", file], { encoding: "utf8" });
      assert.notEqual(r.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
