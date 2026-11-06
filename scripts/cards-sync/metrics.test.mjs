import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractStatus, extractCardId, statusSegments, statusHistoryForFile } from "./metrics.mjs";

const createdDirs = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-metrics-"));
  createdDirs.push(dir);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function commitCardAt(dir, relPath, content, isoDate) {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "x"],
    {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
    }
  );
}

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

test("extractStatus reads the status frontmatter field, treating null/empty as no status", () => {
  assert.equal(extractStatus("card_id: X\nstatus: In Progress\n"), "In Progress");
  assert.equal(extractStatus('status: "Done"\n'), "Done");
  assert.equal(extractStatus("status: null\n"), null);
  assert.equal(extractStatus("card_id: X\n"), null);
});

test("extractCardId reads the card_id frontmatter field", () => {
  assert.equal(extractCardId("card_id: PROJ-TASK-001\nstatus: Backlog\n"), "PROJ-TASK-001");
  assert.equal(extractCardId("status: Backlog\n"), null);
});

test("statusSegments turns a chronological history into closed + one ongoing segment", () => {
  const history = [
    { date: "2026-01-01T00:00:00Z", status: "Backlog" },
    { date: "2026-01-04T00:00:00Z", status: "In Progress" },
    { date: "2026-01-06T00:00:00Z", status: "Done" },
  ];
  const now = new Date("2026-01-10T00:00:00Z");
  const segments = statusSegments(history, now);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].status, "Backlog");
  assert.equal(segments[0].days, 3);
  assert.equal(segments[0].ongoing, false);
  assert.equal(segments[1].status, "In Progress");
  assert.equal(segments[1].days, 2);
  assert.equal(segments[1].ongoing, false);
  assert.equal(segments[2].status, "Done");
  assert.equal(segments[2].ongoing, true); // no next transition yet — still the current status
});

test("statusHistoryForFile mines real git history and only records distinct status changes", () => {
  const dir = makeRepo();
  const rel = ".github/cards/tasks/PROJ-TASK-001.md";

  commitCardAt(
    dir,
    rel,
    "---\ncard_id: PROJ-TASK-001\nstatus: Backlog\n---\n\nbody\n",
    "2026-01-01T09:00:00+00:00"
  );
  // A commit that touches the file without changing status must NOT add a
  // new history entry — only real status changes count.
  commitCardAt(
    dir,
    rel,
    "---\ncard_id: PROJ-TASK-001\nstatus: Backlog\n---\n\nbody edited\n",
    "2026-01-02T09:00:00+00:00"
  );
  commitCardAt(
    dir,
    rel,
    "---\ncard_id: PROJ-TASK-001\nstatus: In Progress\n---\n\nbody edited\n",
    "2026-01-05T09:00:00+00:00"
  );
  commitCardAt(
    dir,
    rel,
    "---\ncard_id: PROJ-TASK-001\nstatus: Done\n---\n\nbody edited\n",
    "2026-01-08T09:00:00+00:00"
  );

  const history = statusHistoryForFile(dir, rel);
  assert.equal(history.length, 3, JSON.stringify(history));
  assert.equal(history[0].status, "Backlog");
  assert.equal(history[1].status, "In Progress");
  assert.equal(history[2].status, "Done");
  // oldest-first
  assert.ok(new Date(history[0].date) < new Date(history[1].date));
  assert.ok(new Date(history[1].date) < new Date(history[2].date));

  const segments = statusSegments(history, new Date("2026-01-10T00:00:00Z"));
  assert.equal(Math.round(segments[0].days), 4); // Backlog: Jan 1 -> Jan 5
  assert.equal(Math.round(segments[1].days), 3); // In Progress: Jan 5 -> Jan 8
  assert.equal(segments[2].ongoing, true); // Done: still the latest status
});

test("statusHistoryForFile returns an empty array for a file with no git history", () => {
  const dir = makeRepo();
  assert.deepEqual(statusHistoryForFile(dir, ".github/cards/tasks/NEVER-COMMITTED.md"), []);
});

const metricsScript = join(dirname(fileURLToPath(import.meta.url)), "metrics.mjs");
const runMetrics = (cwd, args = [], execArgv = [], env = {}) =>
  spawnSync(process.execPath, [...execArgv, metricsScript, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HYPERION_ROOT: "", ...env },
  });

test("CLI: WIP by status and average time per closed status segment (text and --json); renames are followed", () => {
  const dir = makeRepo();
  const card = (id, status) => [`.github/cards/tasks/_orphan/${id}.md`, `---\ncard_id: ${id}\nstatus: ${status}\n---\n`];
  commitCardAt(dir, ...card("A", "Backlog"), "2026-01-01T00:00:00+00:00");
  commitCardAt(dir, ...card("B", "null"), "2026-01-02T00:00:00+00:00");
  commitCardAt(dir, ...card("C", "Backlog"), "2026-01-02T00:00:00+00:00");
  commitCardAt(dir, ...card("A", "In Progress"), "2026-01-03T00:00:00+00:00");
  commitCardAt(dir, "old/D.md", card("D", "In Tests")[1], "2026-01-04T00:00:00+00:00");
  spawnSync("git", ["mv", "old/D.md", card("D")[0]], { cwd: dir });
  commitCardAt(dir, ...card("C", "Done"), "2026-01-05T00:00:00+00:00");
  writeFileSync(join(dir, ".github/cards/tasks/_orphan/UNCOMMITTED.md"), "---\ncard_id: U\n---\n");

  // --follow lists the pre-rename commit too; the new path doesn't exist there and is skipped.
  const renamed = statusHistoryForFile(dir, card("D")[0]);
  assert.deepEqual(renamed.map((h) => h.status), ["In Tests"]);
  assert.match(renamed[0].date, /^2026-01-05/);

  const json = runMetrics(dir, ["--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    currentWip: { "In Progress": 1, "In Tests": 1, Done: 1 },
    cycleTimeByStatus: { Backlog: { avgDays: 2.5, samples: 2 } },
    cardCount: 5,
  });

  const text = runMetrics(dir);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\[cards-metrics\] 5 card\(s\) with git history/);
  assert.match(text.stdout, /WIP now, by status:\n {4}1 {2}/);
  for (const status of ["In Progress", "In Tests", "Done"]) assert.match(text.stdout, new RegExp(`\\n {4}1 {2}${status}\\n`));
  assert.match(text.stdout, / {3}2\.5d avg {2}Backlog {2}\(2 samples\)/);
});

test("CLI: no cards / no history prints placeholders", () => {
  const r = runMetrics(makeRepo());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 card\(s\)/);
  assert.match(r.stdout, /\(no cards with a status set\)/);
  assert.match(r.stdout, /\(not enough history yet/);
});

test("CLI: unexpected errors are reported as FATAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-metrics-fatal-"));
  createdDirs.push(dir);
  const preload = join(dir, "throw.mjs");
  writeFileSync(preload, `console.log = () => { throw new Error("injected"); };\n`);
  const r = runMetrics(dir, [], ["--import", pathToFileURL(preload).href]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[cards-metrics\] FATAL: injected/);
});
