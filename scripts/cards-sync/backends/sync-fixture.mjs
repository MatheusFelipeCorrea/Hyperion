/**
 * Test support for backend sync runs: a throwaway workspace with real card files
 * and a routed fetch stub. sync.mjs resolves the workspace from process.cwd() and
 * DRY_RUN when it loads, so call setupWorkspace() BEFORE importing a backend:
 *
 *   const ws = setupWorkspace({ "stories/S-1.md": cardMarkdown({ id: "S-1" }) });
 *   const { runForwardSyncLinear } = await import("./linear.mjs");
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export function cardMarkdown({ id, title = `Card ${id}`, type = "Story", status = "Backlog", priority = "Medium", parent = null, categories = [] }) {
  const cats = categories.length ? `categories:\n${categories.map((c) => `  - ${c}`).join("\n")}\n` : "categories: []\n";
  return `---\ncard_id: ${id}\ntitle: "${title}"\nstatus: ${status}\ntype: ${type}\npriority: ${priority}\nsprint: null\nstory_points: 3\nreporter: null\nparent: ${parent ?? "null"}\ndue_date: null\n${cats}---\n\n# ${title}\n\nBody of ${id}.\n`;
}

/** Env vars that change what a sync run does; the developer's shell must not leak them into tests. */
const ISOLATED_ENV = [
  "CARDS_SYNC_INCLUDE_SAMPLES",
  "CARDS_SYNC_INCLUDE_EXAMPLES",
  "CARDS_SYNC_ONLY",
  "SYNC_DIRECTION",
  "CARDS_SYNC_BACKEND",
  "HYPERION_ROOT",
];

/** @param {Record<string, string>} cards paths relative to .github/cards */
export function setupWorkspace(cards = {}, { dryRun = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hyperion-backend-"));
  mkdirSync(join(root, ".github", "cards", "config"), { recursive: true });
  for (const [rel, content] of Object.entries(cards)) {
    const abs = join(root, ".github", "cards", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const env = {
    GITHUB_REPOSITORY: "acme/app",
    PROJECT_SYNC_TOKEN: "test-token",
    HYPERION_NO_DOTENV: "1",
    DRY_RUN: dryRun ? "true" : undefined,
    ...Object.fromEntries(ISOLATED_ENV.map((k) => [k, undefined])),
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const savedCwd = process.cwd();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.chdir(root);
  return {
    root,
    path: (rel) => join(root, rel),
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    write: (rel, content) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    },
    cleanup: () => {
      process.chdir(existsSync(savedCwd) ? savedCwd : tmpdir());
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Replaces globalThis.fetch. `route(req)` gets { url, method, headers, body (parsed JSON
 * when possible), raw } and returns a Response, a plain object (sent as JSON 200), or
 * undefined (unmocked: answered with status 599, never a 404 a backend could read as
 * "not found").
 *
 * Unmocked requests and errors thrown by `route` (e.g. a failed assert) are recorded in
 * `failures`, because the backend under test may catch them and carry on. `restore()`
 * throws if any were recorded, so every test that restores in `finally` fails loudly.
 */
export function mockFetch(route) {
  const original = globalThis.fetch;
  const calls = [];
  const failures = [];
  globalThis.fetch = async (input, init = {}) => {
    const raw = typeof init.body === "string" ? init.body : null;
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    const req = { url: String(input), method: (init.method || "GET").toUpperCase(), headers: init.headers || {}, body, raw };
    calls.push(req);
    let res;
    try {
      res = await route(req);
    } catch (err) {
      failures.push(`${req.method} ${req.url}: ${err?.message || err}`);
      throw err;
    }
    if (res instanceof Response) return res;
    if (res === undefined) {
      const message = `unmocked ${req.method} ${req.url}`;
      failures.push(message);
      return jsonResponse({ message }, 599);
    }
    return jsonResponse(res);
  };
  return {
    calls,
    failures,
    restore: () => {
      globalThis.fetch = original;
      if (failures.length) {
        throw new Error(`fetch mock recorded ${failures.length} failure(s):\n${failures.splice(0).join("\n")}`);
      }
    },
  };
}

/** Captures console.log lines while fn runs. */
export async function captureLogs(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}
