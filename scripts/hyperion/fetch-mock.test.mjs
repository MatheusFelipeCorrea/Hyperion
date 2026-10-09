import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithFetchMock } from "./fetch-mock.mjs";

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
       console.log(JSON.stringify([await a.json(), await b.json(), c.status, d.status]));`
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
    assert.deepEqual(JSON.parse(run.stdout), [{ hits: 11, body: { n: 1 } }, { hits: 12, body: null }, 404, 204]);
    assert.deepEqual(run.calls.map((c) => c.method), ["POST", "GET", "GET", "PUT"]);
    assert.equal(run.calls[0].headers["x-k"], "v");
    assert.equal(run.calls[3].body, "plain");
    assert.equal(run.state.hits, 12);

    const noMock = runWithFetchMock(join(dir, "client.mjs"), [], { cwd: dir, env: { UNSET_ME: undefined } });
    assert.notEqual(noMock.status, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
