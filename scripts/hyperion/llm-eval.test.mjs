import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWithFetchMock } from "./fetch-mock.mjs";
import {
  loadCases,
  scoreOutput,
  callAnthropic,
  callOpenAI,
  callProvider,
} from "./llm-eval.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "llm-eval.mjs");

test("loadCases reads the real llm-cases.json as a non-empty array", () => {
  const cases = loadCases();
  assert.ok(Array.isArray(cases));
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.ok(c.id, "each case needs an id");
  }
});

test("scoreOutput passes when text satisfies mustContain and mustMatch", () => {
  const ok = scoreOutput("## Resumo\n### Concluído\n- x\n### Pendente\n- y\n", {
    id: "t",
    mustContain: ["Concluído", "Pendente"],
    mustMatch: ["^## .*Resumo"],
  });
  assert.equal(ok, true);
});

test("scoreOutput fails when a mustContain string is missing", () => {
  const ok = scoreOutput("nothing relevant here", {
    id: "t",
    mustContain: ["Concluído"],
  });
  assert.equal(ok, false);
});

test("scoreOutput fails when a mustMatch pattern doesn't match", () => {
  const ok = scoreOutput("no heading here", {
    id: "t",
    mustMatch: ["^## Resumo"],
  });
  assert.equal(ok, false);
});

test("callAnthropic sends the messages payload and joins text blocks", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(options.headers["x-api-key"], "test-key");
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].content, "hello");
      return {
        ok: true,
        json: async () => ({ content: [{ text: "part one " }, { text: "part two" }] }),
      };
    };
    const out = await callAnthropic("hello");
    assert.equal(out, "part one part two");
  } finally {
    global.fetch = originalFetch;
    process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

test("callAnthropic throws with status + body on a non-ok response", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 401, text: async () => "invalid key" });
    await assert.rejects(() => callAnthropic("hi"), /Anthropic 401: invalid key/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callOpenAI sends chat completions payload and reads the message content", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].content, "hello");
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "reply" } }] }),
      };
    };
    const out = await callOpenAI("hello");
    assert.equal(out, "reply");
  } finally {
    global.fetch = originalFetch;
  }
});

test("callProvider prefers Anthropic over OpenAI when both keys are set", async () => {
  const originalFetch = global.fetch;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOpenAI = process.env.OPENAI_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "a-key";
    process.env.OPENAI_API_KEY = "o-key";
    global.fetch = async (url) => {
      assert.match(url, /anthropic\.com/);
      return { ok: true, json: async () => ({ content: [{ text: "from anthropic" }] }) };
    };
    const out = await callProvider("hi");
    assert.equal(out, "from anthropic");
  } finally {
    global.fetch = originalFetch;
    process.env.ANTHROPIC_API_KEY = originalAnthropic;
    process.env.OPENAI_API_KEY = originalOpenAI;
  }
});

test("callOpenAI throws with status + body on a non-ok response and tolerates empty choices", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 429, text: async () => "slow down" });
    await assert.rejects(() => callOpenAI("hi"), /OpenAI 429: slow down/);
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    assert.equal(await callOpenAI("hi"), "");
  } finally {
    global.fetch = originalFetch;
  }
});

describe("llm-eval CLI --root", () => {
  let dir;
  let route;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "hyperion-llm-eval-"));
    route = join(dir, "route.mjs");
    writeFileSync(
      route,
      `export default (req, state) => {
         if (state.status) return new Response("upstream down", { status: state.status });
         if (req.url.includes("anthropic.com")) return { content: [{ text: state.text }, { type: "tool_use" }] };
         return { choices: [{ message: { content: state.text } }] };
       };`
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  let n = 0;
  /** Fresh kit root with .github/skills/eval/{llm-cases.json,golden/,prompts/}. */
  function kit({ cases, golden = {}, prompts = {} }) {
    const root = join(dir, `kit-${n++}`);
    const evalRoot = join(root, ".github/skills/eval");
    mkdirSync(join(evalRoot, "golden"), { recursive: true });
    mkdirSync(join(evalRoot, "prompts"), { recursive: true });
    if (cases !== undefined) writeFileSync(join(evalRoot, "llm-cases.json"), JSON.stringify(cases));
    for (const [f, t] of Object.entries(golden)) writeFileSync(join(evalRoot, "golden", f), t);
    for (const [f, t] of Object.entries(prompts)) writeFileSync(join(evalRoot, "prompts", f), t);
    return root;
  }

  const NO_LIVE = { HYPERION_LLM_EVAL_LIVE: undefined, HYPERION_LLM_MODEL: undefined };
  const run = (root, env = {}, state) =>
    runWithFetchMock(script, ["--root", root], { cwd: dir, route, state, env: { ...NO_LIVE, ...env } });

  it("fails when llm-cases.json is missing or not a non-empty array", () => {
    let r = run(kit({}));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL: missing \.github\/skills\/eval\/llm-cases\.json/);

    r = run(kit({ cases: [] }));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /llm-cases\.json must be a non-empty array/);

    r = run(kit({ cases: { id: "x" } }));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /must be a non-empty array/);
  });

  it("fixture mode scores goldens (custom golden name, missing golden, mismatches)", () => {
    const root = kit({
      cases: [
        { id: "ok", mustContain: ["Hello"] },
        { id: "custom", golden: "other.txt", mustMatch: ["^## Heading"] },
        { id: "bad", mustContain: ["Nope"] },
        { id: "nogolden" },
      ],
      golden: { "ok.txt": "Hello world\n", "other.txt": "intro\n## Heading\n", "bad.txt": "x", "notes.md": "x" },
    });
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /OK ok \(fixture\)/);
    assert.match(r.stdout, /OK custom \(fixture\)/);
    assert.match(r.stderr, /FAIL bad: missing "Nope"/);
    assert.match(r.stderr, /FAIL nogolden: golden missing \.github[\\/]skills[\\/]eval[\\/]golden[\\/]nogolden\.txt/);
    assert.match(r.stderr, /llm-eval FAILED — 2\/4 cases/);
    assert.equal(r.calls.length, 0);

    const pass = run(kit({ cases: [{ id: "ok", mustContain: ["Hello"] }], golden: { "ok.txt": "Hello\n", "z.txt": "" } }));
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /llm-eval OK — 1 cases, 2 golden fixtures \(fixture-only\)/);
  });

  it("live mode calls Anthropic first and scores the reply", () => {
    const root = kit({
      cases: [{ id: "a", mustContain: ["Hello"] }],
      golden: { "a.txt": "Hello\n" },
      prompts: { "a.md": "Say hello" },
    });
    const r = run(root, { HYPERION_LLM_EVAL_LIVE: "1", ANTHROPIC_API_KEY: "fake-a", OPENAI_API_KEY: "fake-o" }, { text: "Hello there" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK a \(live\)/);
    assert.match(r.stdout, /llm-eval OK — 1 cases, 1 golden fixtures \(live\)/);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(r.calls[0].headers["x-api-key"], "fake-a");
    assert.equal(r.calls[0].body.model, "claude-haiku-4-5-20251001");
    assert.equal(r.calls[0].body.messages[0].content, "Say hello");
  });

  it("live mode falls back to OpenAI, flags mismatches and missing prompts", () => {
    const root = kit({
      cases: [{ id: "a", mustMatch: ["^Bonjour"] }, { id: "noprompt" }],
      golden: { "a.txt": "Bonjour\n", "noprompt.txt": "x" },
      prompts: { "a.md": "Say bonjour" },
    });
    const r = run(
      root,
      { HYPERION_LLM_EVAL_LIVE: "1", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "fake-o", HYPERION_LLM_MODEL: "m-1" },
      { text: "Hello" }
    );
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL a: mustMatch \/\^Bonjour\//);
    assert.match(r.stderr, /FAIL noprompt: live prompt missing prompts\/noprompt\.md/);
    assert.match(r.stderr, /llm-eval FAILED — 2\/2 cases/);
    assert.equal(r.calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(r.calls[0].headers.Authorization, "Bearer fake-o");
    assert.equal(r.calls[0].body.model, "m-1");
  });

  it("live mode without any provider key exits with a clear message", () => {
    const root = kit({ cases: [{ id: "a" }], golden: { "a.txt": "x" }, prompts: { "a.md": "p" } });
    const r = run(root, { HYPERION_LLM_EVAL_LIVE: "1", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL live mode: set ANTHROPIC_API_KEY or OPENAI_API_KEY/);
    assert.equal(r.calls.length, 0);
  });

  it("a provider error is reported as FATAL", () => {
    const root = kit({ cases: [{ id: "a" }], golden: { "a.txt": "x" }, prompts: { "a.md": "p" } });
    const r = run(root, { HYPERION_LLM_EVAL_LIVE: "1", ANTHROPIC_API_KEY: "fake-a" }, { status: 500 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /llm-eval FATAL: Anthropic 500: upstream down/);
  });
});
