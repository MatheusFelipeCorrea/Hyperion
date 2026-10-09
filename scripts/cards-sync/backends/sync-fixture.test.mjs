import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mockFetch, setupWorkspace } from "./sync-fixture.mjs";

test("setupWorkspace isolates sync env vars and cleanup restores env and cwd", () => {
  const cwd = process.cwd();
  const touched = ["CARDS_SYNC_INCLUDE_SAMPLES", "CARDS_SYNC_ONLY", "SYNC_DIRECTION", "CARDS_SYNC_BACKEND", "DRY_RUN", "GITHUB_REPOSITORY"];
  const before = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    CARDS_SYNC_INCLUDE_SAMPLES: "true",
    CARDS_SYNC_ONLY: "X-1",
    SYNC_DIRECTION: "reverse",
    CARDS_SYNC_BACKEND: "jira",
    GITHUB_REPOSITORY: "someone/else",
  });
  delete process.env.DRY_RUN;
  try {
    const ws = setupWorkspace({}, { dryRun: true });
    assert.equal(realpathSync(process.cwd()), realpathSync(ws.root));
    for (const k of ["CARDS_SYNC_INCLUDE_SAMPLES", "CARDS_SYNC_ONLY", "SYNC_DIRECTION", "CARDS_SYNC_BACKEND"]) {
      assert.equal(process.env[k], undefined, k);
    }
    assert.equal(process.env.DRY_RUN, "true");
    assert.equal(process.env.GITHUB_REPOSITORY, "acme/app");

    ws.cleanup();
    assert.equal(process.cwd(), cwd);
    assert.equal(process.env.CARDS_SYNC_ONLY, "X-1");
    assert.equal(process.env.SYNC_DIRECTION, "reverse");
    assert.equal(process.env.CARDS_SYNC_INCLUDE_SAMPLES, "true");
    assert.equal(process.env.CARDS_SYNC_BACKEND, "jira");
    assert.equal(process.env.GITHUB_REPOSITORY, "someone/else");
    assert.equal(process.env.DRY_RUN, undefined);
    assert.equal(ws.exists(""), false);
  } finally {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("mockFetch answers unmocked calls with 599 and restore() reports them", async () => {
  const api = mockFetch(() => undefined);
  const res = await fetch("https://api.example/missing", { method: "POST" });
  assert.equal(res.status, 599);
  assert.match((await res.json()).message, /unmocked POST https:\/\/api\.example\/missing/);
  assert.throws(() => api.restore(), /1 failure\(s\):\nunmocked POST https:\/\/api\.example\/missing/);
});

test("mockFetch records route errors the code under test swallowed", async () => {
  const original = globalThis.fetch;
  const api = mockFetch(() => assert.fail("unexpected write"));
  await fetch("https://api.example/x").catch(() => "swallowed by the backend");
  assert.equal(api.failures.length, 1);
  assert.throws(() => api.restore(), /GET https:\/\/api\.example\/x: unexpected write/);
  assert.equal(globalThis.fetch, original, "fetch is restored even when restore() throws");
});

test("mockFetch restore() is quiet when every call was routed", async () => {
  const api = mockFetch(() => ({ ok: true }));
  assert.deepEqual(await (await fetch("https://api.example/x")).json(), { ok: true });
  api.restore();
  assert.equal(api.calls.length, 1);
});
