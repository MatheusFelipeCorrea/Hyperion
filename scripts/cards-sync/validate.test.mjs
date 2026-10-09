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

function runValidate(cwd, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8", env: { ...process.env, HYPERION_ROOT: "" } });
}

function writeCard(dir, rel, frontmatter) {
  const abs = join(dir, ".github", "cards", rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\nbody\n`);
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

test("no card files is not an error", () => {
  const r = runValidate(makeCardsRepo());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No card files found under \.github\/cards\//);
});

test("every field rule is reported and fails validation", () => {
  const dir = makeCardsRepo();
  writeCard(dir, "tasks/_orphan/NUM.md", "card_id: 123\ntype: Task");
  writeCard(dir, "tasks/_orphan/D-1.md", "card_id: D-1\ntype: Task");
  writeCard(dir, "tasks/other/D-1.md", "card_id: D-1\ntype: Task");
  writeCard(
    dir,
    "tasks/_orphan/BAD-1.md",
    "card_id: BAD-1\ntype: Bogus\npriority: P0\nstatus: Doing\nstory_points: 2.5\ndue_date: 2026/01/01\nparent: MISSING-1\nsprint: null\ncategories: [a, \"b\"]"
  );
  writeCard(dir, "tasks/_orphan/BAD-2.md", "card_id: BAD-2\ntype: Task\nstatus: 5\nparent: 42\ncategories:\n  - x\n  - ''\nreporter: ana");
  const r = runValidate(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout;
  assert.match(out, /❌ Cards validation failed/);
  assert.match(out, /NUM\.md: card_id is required \(string\)\./);
  assert.match(out, /\/D-1\.md: duplicate card_id "D-1"\./);
  assert.match(out, /BAD-1\.md: type "Bogus" is not allowed/);
  assert.match(out, /BAD-1\.md: priority "P0" is not allowed/);
  assert.match(out, /BAD-1\.md: status "Doing" is not allowed/);
  assert.match(out, /BAD-1\.md: story_points must be an integer number/);
  assert.match(out, /BAD-1\.md: due_date must be YYYY-MM-DD/);
  assert.match(out, /BAD-1\.md: parent "MISSING-1" not found among local card_ids\./);
  assert.match(out, /BAD-2\.md: status must be a string \(or null\)\./);
  assert.match(out, /BAD-2\.md: parent must be a CARD_ID string or null\./);
  assert.doesNotMatch(out, /categories must be/);
});

test("config sanity: locale + non-GitHub backend notice, layout warnings and --strict-layout", () => {
  const dir = makeCardsRepo();
  writeFileSync(join(dir, ".github", "project.yml"), "locale: pt-BR\nmanagement:\n  backend: linear\n");
  mkdirSync(join(dir, ".github", "cards", "config"), { recursive: true });
  writeFileSync(join(dir, ".github", "cards", "config", "projects-map.json"), "{}");
  writeCard(dir, "stories/WRONG/S-1.md", "card_id: S-1\ntype: Story\nparent: F-1\ndue_date: 2026-01-02");
  writeCard(dir, "features/F-1.md", "card_id: F-1\ntype: Feature");
  writeCard(dir, "_examples/stories/EX-1.md", "card_id: EX-1\ntype: Story");

  const r = runValidate(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /management\.backend is set to "linear"/);
  assert.match(r.stdout, /Locale detected in project\.yml: pt-BR/);
  assert.doesNotMatch(r.stdout, /Missing config files/);
  assert.match(r.stdout, /S-1\.md: layout — expected path \.github\/cards\/stories\/F-1\/S-1\.md \(parent folder = parent card_id\)/);
  assert.match(r.stdout, /F-1\.md: layout — legacy flat path — prefer nested: \.github\/cards\/features\/_orphan\/F-1\.md/);
  assert.doesNotMatch(r.stdout, /EX-1\.md: layout/);
  assert.match(r.stdout, /Valid cards: 3/);

  const strict = runValidate(dir, ["--strict-layout"]);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /- \.github\/cards\/stories\/WRONG\/S-1\.md: layout — expected path/);
});

test("config sanity: locale followed by an inline YAML comment is still detected", () => {
  const dir = makeCardsRepo();
  writeFileSync(join(dir, ".github", "project.yml"), "locale: pt-BR # team language\n");
  mkdirSync(join(dir, ".github", "cards", "config"), { recursive: true });
  writeFileSync(join(dir, ".github", "cards", "config", "projects-map.json"), "{}");
  writeCard(dir, "tasks/_orphan/T-1.md", "card_id: T-1\ntype: Task");
  const r = runValidate(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Locale detected in project\.yml: pt-BR\n/);
});

test("config sanity checks never break validation (unreadable project.yml)", () => {
  const dir = makeCardsRepo();
  mkdirSync(join(dir, ".github", "project.yml"));
  mkdirSync(join(dir, ".github", "cards", "config"), { recursive: true });
  writeFileSync(join(dir, ".github", "cards", "config", "projects-map.json"), "{}");
  writeCard(dir, "tasks/_orphan/T-1.md", "card_id: T-1\ntype: Task");
  const r = runValidate(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /Missing config files|Locale detected/);
  assert.match(r.stdout, /Valid cards: 1/);
});
