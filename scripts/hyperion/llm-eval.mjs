#!/usr/bin/env node
/**
 * LLM eval harness (opt-in live mode).
 *
 * Default (CI-safe): validates golden fixture files + case schema — no API calls.
 * Live: HYPERION_LLM_EVAL_LIVE=1 + provider env vars — compares model output to golden.
 *
 * Run: npm run hyperion:llm-eval
 * Live: HYPERION_LLM_EVAL_LIVE=1 OPENAI_API_KEY=... npm run hyperion:llm-eval
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const evalRoot = join(root, ".github/skills/eval");
const casesPath = join(evalRoot, "llm-cases.json");
const goldenDir = join(evalRoot, "golden");

const live = String(process.env.HYPERION_LLM_EVAL_LIVE || "").toLowerCase() === "1";

export function loadCases() {
  if (!existsSync(casesPath)) {
    console.error("FAIL: missing .github/skills/eval/llm-cases.json");
    process.exit(1);
  }
  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error("FAIL: llm-cases.json must be a non-empty array");
    process.exit(1);
  }
  return cases;
}

export function scoreOutput(text, c) {
  let ok = true;
  for (const needle of c.mustContain || []) {
    if (!text.includes(needle)) {
      console.error(`FAIL ${c.id}: missing "${needle}"`);
      ok = false;
    }
  }
  for (const pattern of c.mustMatch || []) {
    const re = new RegExp(pattern, "m");
    if (!re.test(text)) {
      console.error(`FAIL ${c.id}: mustMatch /${pattern}/`);
      ok = false;
    }
  }
  return ok;
}

export async function callAnthropic(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.HYPERION_LLM_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.content || []).map((block) => block.text || "").join("");
}

export async function callOpenAI(prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.HYPERION_LLM_MODEL || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function callProvider(prompt) {
  if (process.env.ANTHROPIC_API_KEY) return callAnthropic(prompt);
  if (process.env.OPENAI_API_KEY) return callOpenAI(prompt);
  console.error("FAIL live mode: set ANTHROPIC_API_KEY or OPENAI_API_KEY");
  process.exit(1);
}

async function main() {
  const cases = loadCases();
  let failed = 0;

  for (const c of cases) {
    const goldenPath = join(goldenDir, c.golden || `${c.id}.txt`);
    if (!existsSync(goldenPath)) {
      console.error(`FAIL ${c.id}: golden missing ${goldenPath.replace(root + "\\", "").replace(root + "/", "")}`);
      failed++;
      continue;
    }
    const golden = readFileSync(goldenPath, "utf8");

    if (!live) {
      if (!scoreOutput(golden, c)) failed++;
      else console.log(`OK ${c.id} (fixture)`);
      continue;
    }

    const promptPath = join(evalRoot, "prompts", `${c.id}.md`);
    if (!existsSync(promptPath)) {
      console.error(`FAIL ${c.id}: live prompt missing prompts/${c.id}.md`);
      failed++;
      continue;
    }
    const prompt = readFileSync(promptPath, "utf8");
    const output = await callProvider(prompt);
    if (!scoreOutput(output, c)) failed++;
    else console.log(`OK ${c.id} (live)`);
  }

  const goldenCount = readdirSync(goldenDir).filter((f) => f.endsWith(".txt")).length;
  if (failed) {
    console.error(`\nllm-eval FAILED — ${failed}/${cases.length} cases`);
    process.exit(1);
  }
  console.log(
    `\nllm-eval OK — ${cases.length} cases, ${goldenCount} golden fixtures${live ? " (live)" : " (fixture-only)"}`
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error("llm-eval FATAL:", err.message);
    process.exit(1);
  });
}
