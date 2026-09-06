import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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
