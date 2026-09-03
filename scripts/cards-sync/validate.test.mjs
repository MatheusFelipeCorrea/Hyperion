import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "validate.mjs");
const createdDirs = [];

function makeCardsRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-validate-"));
  createdDirs.push(dir);
  mkdirSync(join(dir, ".github", "cards", "tasks"), { recursive: true });
  return dir;
}

function runValidate(cwd) {
  return spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
}

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

test("passes with valid cards, reports the right count, no skip warnings", () => {
  const dir = makeCardsRepo();
  writeFileSync(
    join(dir, ".github", "cards", "tasks", "PROJ-TASK-001.md"),
    "---\ncard_id: PROJ-TASK-001\ntitle: \"x\"\nstatus: Backlog\ntype: Task\n---\n\nbody\n"
  );
  const r = runValidate(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Valid cards: 1/);
  assert.doesNotMatch(r.stdout, /skipped/);
});

test("a card with malformed frontmatter (no closing ---) is reported loudly, not silently dropped", () => {
  const dir = makeCardsRepo();
  writeFileSync(
    join(dir, ".github", "cards", "tasks", "BROKEN-001.md"),
    "---\ncard_id: BROKEN-001\ntitle: \"never closed\"\n\nbody with no closing delimiter\n"
  );
  const r = runValidate(dir);
  // Non-fatal by design (matches the pre-existing layout-warning precedent),
  // but must be visible — this is the exact bug: previously it vanished
  // with zero trace and validate.mjs still printed "OK".
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 file\(s\) skipped/);
  assert.match(r.stdout, /BROKEN-001\.md/);
  assert.match(r.stdout, /malformed frontmatter/);
  assert.match(r.stdout, /Valid cards: 0/);
});

test("a card missing card_id is reported loudly with the specific reason", () => {
  const dir = makeCardsRepo();
  writeFileSync(
    join(dir, ".github", "cards", "tasks", "NOID.md"),
    "---\ntitle: \"no card_id here\"\nstatus: Backlog\ntype: Task\n---\n\nbody\n"
  );
  const r = runValidate(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /NOID\.md/);
  assert.match(r.stdout, /missing required `card_id`/);
});

test("a card with real categories still validates cleanly (removing the dead Array.isArray check didn't break the real per-element check)", () => {
  const dir = makeCardsRepo();
  writeFileSync(
    join(dir, ".github", "cards", "tasks", "PROJ-TASK-002.md"),
    "---\ncard_id: PROJ-TASK-002\ntitle: \"x\"\nstatus: Backlog\ntype: Task\ncategories:\n  - Backend\n  - API\n---\n\nbody\n"
  );
  const r = runValidate(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Valid cards: 1/);
});
