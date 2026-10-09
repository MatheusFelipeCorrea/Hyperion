import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace, runCli } from "./fixtures/cards-cli-harness.mjs";

const card = (fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# Body\n`;

function layoutWorkspace() {
  return createWorkspace({
    files: {
      ".github/cards/_examples/stories/EX-1.md": card({ card_id: "EX-1", type: "Story" }),
      ".github/cards/stories/NOID.md": card({ title: "no id" }),
      ".github/cards/notes.md": "plain notes, no frontmatter\n",
      ".github/cards/epics/E-1.md": card({ card_id: "E-1", type: "Epic", parent: "null" }),
      ".github/cards/stories/S-1.md": card({ card_id: "S-1", type: "Story", parent: "E-1" }),
      ".github/cards/S-2.md": card({ card_id: "'S-2'", type: "", parent: "null" }),
    },
  });
}

test("migrate-layout: no cards → nothing to do, exit 0", () => {
  const ws = createWorkspace();
  try {
    const run = runCli("migrate-layout.mjs", [], { ws });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /Dry-run mode \(pass --yes to apply\)/);
    assert.match(run.stdout, /No cards found under \.github\/cards\//);
  } finally {
    ws.cleanup();
  }
});

test("migrate-layout: dry-run previews moves and touches nothing", () => {
  const ws = layoutWorkspace();
  try {
    const run = runCli("migrate-layout.mjs", [], { ws });
    assert.equal(run.status, 0, run.out);
    assert.match(run.stdout, /SKIP \(no card_id\): \.github\/cards\/stories\/NOID\.md/);
    assert.match(run.stdout, /SKIP \(no card_id\): \.github\/cards\/notes\.md/);
    assert.match(run.stdout, /Would move: \.github\/cards\/stories\/S-1\.md → \.github\/cards\/stories\/E-1\/S-1\.md/);
    assert.match(run.stdout, /Would move: \.github\/cards\/S-2\.md → \.github\/cards\/stories\/_orphan\/S-2\.md/);
    assert.doesNotMatch(run.stdout, /EX-1|E-1\.md →/, "_examples and already-nested cards are left alone");
    assert.match(run.stdout, /Dry-run complete\. Would move: 2; skip: 4; conflicts: 0/);
    assert.ok(ws.exists(".github/cards/stories/S-1.md"));
    assert.ok(!ws.exists(".github/cards/stories/E-1/S-1.md"));
  } finally {
    ws.cleanup();
  }
});

test("migrate-layout: --yes moves files into the nested layout", () => {
  const ws = layoutWorkspace();
  const before = ws.read(".github/cards/S-2.md");
  try {
    const run = runCli("migrate-layout.mjs", ["--yes"], { ws });
    assert.equal(run.status, 0, run.out);
    assert.doesNotMatch(run.stdout, /Dry-run mode/);
    assert.match(run.stdout, /Moved: \.github\/cards\/stories\/S-1\.md → \.github\/cards\/stories\/E-1\/S-1\.md/);
    assert.match(run.stdout, /Done\. Moved: 2; skip: 4; conflicts: 0/);
    assert.ok(!ws.exists(".github/cards/stories/S-1.md"));
    assert.ok(ws.exists(".github/cards/stories/E-1/S-1.md"));
    assert.equal(ws.read(".github/cards/stories/_orphan/S-2.md"), before);
    assert.ok(ws.exists(".github/cards/_examples/stories/EX-1.md"));
  } finally {
    ws.cleanup();
  }
});

test("migrate-layout: an occupied destination is a conflict → exit 1, file kept", () => {
  const ws = createWorkspace({
    files: {
      ".github/cards/tasks/T-1.md": card({ card_id: "T-1", type: "Task", parent: "S-1" }),
      ".github/cards/tasks/S-1/T-1.md": card({ card_id: "T-1", type: "Task", parent: "S-1" }),
    },
  });
  try {
    const run = runCli("migrate-layout.mjs", ["--yes"], { ws });
    assert.equal(run.status, 1, run.out);
    assert.match(run.stdout, /CONFLICT \(dest exists\): \.github\/cards\/tasks\/T-1\.md → \.github\/cards\/tasks\/S-1\/T-1\.md/);
    assert.match(run.stdout, /Done\. Moved: 0; skip: 1; conflicts: 1/);
    assert.ok(ws.exists(".github/cards/tasks/T-1.md"));
  } finally {
    ws.cleanup();
  }
});
