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

/** @param {Record<string, string>} cards paths relative to .github/cards */
export function setupWorkspace(cards = {}, { dryRun = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hyperion-backend-"));
  mkdirSync(join(root, ".github", "cards", "config"), { recursive: true });
  for (const [rel, content] of Object.entries(cards)) {
    const abs = join(root, ".github", "cards", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  process.env.GITHUB_REPOSITORY = "acme/app";
  process.env.PROJECT_SYNC_TOKEN = "test-token";
  process.env.HYPERION_NO_DOTENV = "1";
  delete process.env.HYPERION_ROOT;
  if (dryRun) process.env.DRY_RUN = "true";
  else delete process.env.DRY_RUN;
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
      process.chdir(tmpdir());
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
 * undefined (404 — so an unexpected call fails loudly).
 */
export function mockFetch(route) {
  const original = globalThis.fetch;
  const calls = [];
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
    const res = await route(req);
    if (res instanceof Response) return res;
    if (res === undefined) return jsonResponse({ message: `unmocked ${req.method} ${req.url}` }, 404);
    return jsonResponse(res);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
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
