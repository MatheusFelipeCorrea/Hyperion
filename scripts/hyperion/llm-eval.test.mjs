import test from "node:test";
import assert from "node:assert/strict";
import {
  loadCases,
  scoreOutput,
  callAnthropic,
  callOpenAI,
  callProvider,
} from "./llm-eval.mjs";

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
