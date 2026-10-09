import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLocalEnv } from "./load-env.mjs";

const dir = mkdtempSync(join(tmpdir(), "hyperion-env-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("loadLocalEnv reads .env.local over .env and never overrides what is set", () => {
  writeFileSync(join(dir, ".env"), "PROJECT_NUMBER=7\nPROJECT_OWNER=from-env\n# comment\nPROJECT_SYNC_TOKEN=ghp_env\n");
  writeFileSync(join(dir, ".env.local"), "PROJECT_NUMBER=42\n");
  const env = { PROJECT_SYNC_TOKEN: "already-set" };

  const loaded = loadLocalEnv(dir, env);

  assert.equal(env.PROJECT_NUMBER, "42");
  assert.equal(env.PROJECT_OWNER, "from-env");
  assert.equal(env.PROJECT_SYNC_TOKEN, "already-set");
  assert.deepEqual(loaded.sort(), ["PROJECT_NUMBER", "PROJECT_OWNER"]);
});

test("loadLocalEnv is a no-op without env files", () => {
  const empty = mkdtempSync(join(tmpdir(), "hyperion-env-empty-"));
  try {
    const env = {};
    assert.deepEqual(loadLocalEnv(empty, env), []);
    assert.deepEqual(env, {});
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
