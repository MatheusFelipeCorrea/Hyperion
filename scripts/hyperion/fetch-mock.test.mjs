import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithFetchMock } from "./fetch-mock.mjs";

/** A local port nothing listens on, so a real fetch fails fast without leaving the machine. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("runWithFetchMock routes the child's fetch, keeps state and records calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-mock-test-"));
  try {
    const script = join(dir, "client.mjs");
    const route = join(dir, "route.mjs");
    writeFileSync(
      script,
      `const a = await fetch("https://api.example/x", { method: "POST", body: JSON.stringify({ n: 1 }), headers: new Headers({ "x-k": "v" }) });
       const b = await fetch("https://api.example/x");
       const c = await fetch("https://api.example/missing");
       const d = await fetch("https://api.example/raw", { method: "PUT", body: "plain" });
       console.log(JSON.stringify([await a.json(), await b.json(), c.status, (await c.json()).message, d.status]));`
    );
    writeFileSync(
      route,
      `export default (req, state) => {
         if (req.url.endsWith("/raw")) return new Response(null, { status: 204 });
         if (!req.url.endsWith("/x")) return undefined;
         state.hits = (state.hits || 0) + 1;
         return { hits: state.hits, body: req.body };
       };`
    );
    const run = runWithFetchMock(script, [], { cwd: dir, route, state: { hits: 10 } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.signal, null);
    assert.equal(run.error, undefined);
    assert.deepEqual(JSON.parse(run.stdout), [
      { hits: 11, body: { n: 1 } },
      { hits: 12, body: null },
      599,
      "unmocked GET https://api.example/missing",
      204,
    ]);
    assert.deepEqual(run.calls.map((c) => c.method), ["POST", "GET", "GET", "PUT"]);
    assert.equal(run.calls[0].headers["x-k"], "v");
    assert.equal(run.calls[3].body, "plain");
    assert.equal(run.state.hits, 12);
    assert.deepEqual(run.mockErrors, [
      { method: "GET", url: "https://api.example/missing", message: "unmocked GET https://api.example/missing" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithFetchMock reports route errors the child swallowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-mock-test-"));
  try {
    const script = join(dir, "client.mjs");
    const route = join(dir, "route.mjs");
    writeFileSync(script, `await fetch("https://api.example/x", { method: "DELETE" }).catch(() => {}); console.log("ok");`);
    writeFileSync(route, `export default (req) => { if (req.method === "DELETE") throw new Error("dry-run must not delete"); };`);
    const run = runWithFetchMock(script, [], { cwd: dir, route });
    assert.equal(run.status, 0, "the child carried on");
    assert.equal(run.stdout.trim(), "ok");
    assert.deepEqual(run.mockErrors, [{ method: "DELETE", url: "https://api.example/x", message: "dry-run must not delete" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithFetchMock without a route leaves fetch alone and drops env set to undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-mock-test-"));
  const port = await closedPort();
  const prev = process.env.UNSET_ME;
  process.env.UNSET_ME = "inherited";
  try {
    const script = join(dir, "client.mjs");
    writeFileSync(
      script,
      `let outcome;
       try { await fetch("http://127.0.0.1:${port}/"); outcome = "connected"; } catch (err) { outcome = err.cause?.code || err.message; }
       console.log(JSON.stringify({ outcome, unset: process.env.UNSET_ME ?? null }));`
    );
    const run = runWithFetchMock(script, [], { cwd: dir, env: { UNSET_ME: undefined } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { outcome: "ECONNREFUSED", unset: null });
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.mockErrors, []);
  } finally {
    if (prev === undefined) delete process.env.UNSET_ME;
    else process.env.UNSET_ME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithFetchMock returns the spawn error and signal", () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-mock-test-"));
  try {
    const run = runWithFetchMock(join(dir, "client.mjs"), [], { cwd: join(dir, "missing-cwd") });
    assert.equal(run.status, null);
    assert.equal(run.signal, null);
    assert.equal(run.error?.code, "ENOENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
