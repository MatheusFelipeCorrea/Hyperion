/**
 * Test support: preload that swaps globalThis.fetch in a CLI run as a subprocess,
 * so tests can drive real entry scripts (sync.mjs, doctor.mjs, ...) without network.
 *
 *   node --import <file-url of this> scripts/cards-sync/sync.mjs --forward
 *
 * HYPERION_FETCH_MOCK  path to a module whose default export is
 *                      `(req, state) => Response | object | undefined`
 *                      (object → JSON 200, undefined → 404 so unmocked calls fail loudly).
 *                      `state` persists across calls within the run.
 * HYPERION_FETCH_LOG   optional path; every request is written there as JSON on exit.
 * HYPERION_FETCH_STATE optional path to a JSON file used as the initial `state`.
 *
 * Driven from tests by runWithFetchMock() in fetch-mock.mjs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const mockPath = process.env.HYPERION_FETCH_MOCK;
if (mockPath) {
  const route = (await import(pathToFileURL(mockPath).href)).default;
  const statePath = process.env.HYPERION_FETCH_STATE;
  const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const raw = typeof init.body === "string" ? init.body : null;
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers || {};
    const req = { url: String(input), method: (init.method || "GET").toUpperCase(), headers, body };
    calls.push(req);
    const res = await route(req, state);
    if (res instanceof Response) return res;
    const status = res === undefined ? 404 : 200;
    const payload = res === undefined ? { message: `unmocked ${req.method} ${req.url}` } : res;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };

  process.on("exit", () => {
    if (process.env.HYPERION_FETCH_LOG) writeFileSync(process.env.HYPERION_FETCH_LOG, JSON.stringify(calls, null, 2));
    if (statePath) writeFileSync(statePath, JSON.stringify(state, null, 2));
  });
}
