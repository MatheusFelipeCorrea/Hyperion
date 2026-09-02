import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHyperionPaths } from "./paths.mjs";

const createdDirs = [];

function makeTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-paths-"));
  createdDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHyperionPaths defaults to legacy when .github/cards at root", () => {
  const dir = makeTemp();
  fs.mkdirSync(path.join(dir, ".github", "cards"), { recursive: true });
  const p = resolveHyperionPaths(dir);
  assert.equal(p.layout, "legacy");
  assert.equal(p.kitRootRel, "");
  assert.equal(p.cardsPrefix, ".github/cards");
  assert.ok(p.cardsRoot.endsWith(path.join(".github", "cards")));
});

test("resolveHyperionPaths auto-detects Hyperion/ nested kit", () => {
  const dir = makeTemp();
  fs.mkdirSync(path.join(dir, "Hyperion", ".github", "cards"), { recursive: true });
  const p = resolveHyperionPaths(dir);
  assert.equal(p.layout, "nested");
  assert.equal(p.kitRootRel, "Hyperion");
  assert.equal(p.cardsPrefix, "Hyperion/.github/cards");
});

test("resolveHyperionPaths honors kit.root in product project.yml", () => {
  const dir = makeTemp();
  fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
  fs.mkdirSync(path.join(dir, "MyKit", ".github", "cards"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github", "project.yml"),
    "version: 1\nkit:\n  root: MyKit\n",
    "utf8"
  );
  const p = resolveHyperionPaths(dir);
  assert.equal(p.kitRootRel, "MyKit");
  assert.equal(p.cardsPrefix, "MyKit/.github/cards");
});

test("HYPERION_ROOT env overrides auto-detect", () => {
  const dir = makeTemp();
  fs.mkdirSync(path.join(dir, "Hyperion", ".github", "cards"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Alt", ".github", "cards"), { recursive: true });
  const prev = process.env.HYPERION_ROOT;
  process.env.HYPERION_ROOT = "Alt";
  try {
    const p = resolveHyperionPaths(dir);
    assert.equal(p.kitRootRel, "Alt");
  } finally {
    if (prev === undefined) delete process.env.HYPERION_ROOT;
    else process.env.HYPERION_ROOT = prev;
  }
});
