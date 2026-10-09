#!/usr/bin/env node
/**
 * LLM eval harness (opt-in live mode).
 *
 * Default (CI-safe, no API calls) does two things, and it's important not
 * to overclaim what either one actually proves:
 *   1. Checks each golden fixture still satisfies its own mustContain/
 *      mustMatch rules — catches a fixture edited out of sync with its
 *      contract. This is a schema check on hand-authored text, NOT
 *      evidence any model still produces acceptable output.
 *   2. Compares each case's `skillHash` (recorded when the golden was last
 *      verified) against the SKILL.md's current content hash. A mismatch
 *      means the skill changed since anyone confirmed the golden still
 *      represents what that skill would produce today — printed as a
 *      WARN, not a FAIL, since a skill edit isn't proof the golden is
 *      wrong, only that it's unverified.
 * Neither check runs a model. Only live mode (below) does — and CI never
 * sets HYPERION_LLM_EVAL_LIVE, on purpose (it needs a real API key/budget
 * decision this repo hasn't made), so "llm-eval passing" in CI has never
 * meant "a real LLM still produces acceptable output" — only that the
 * fixtures are internally consistent and none of their skills silently
 * drifted out from under them.
 *
 * Live: HYPERION_LLM_EVAL_LIVE=1 + provider env vars — compares real model
 * output to golden, the only mode that actually exercises an LLM.
 *
 * Run: npm run hyperion:llm-eval
 * Live: HYPERION_LLM_EVAL_LIVE=1 OPENAI_API_KEY=... npm run hyperion:llm-eval
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ciError } from "./ci-annotate.mjs";
import { rootArg } from "./cli-args.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = rootArg(join(__dirname, "../.."));
const evalRoot = join(root, ".github/skills/eval");
const casesPath = join(evalRoot, "llm-cases.json");
const goldenDir = join(evalRoot, "golden");

const live = String(process.env.HYPERION_LLM_EVAL_LIVE || "").toLowerCase() === "1";

/** Models used in live mode when HYPERION_LLM_MODEL is unset. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/** Line endings are normalized so a CRLF checkout (Windows) and an LF one (CI) hash the same. */
export function hashFile(absPath) {
  return createHash("sha256").update(readFileSync(absPath, "utf8").replace(/\r\n/g, "\n")).digest("hex");
}

/** Returns null if the case has no skillHash to check (nothing to compare),
 * true if the skill's current content still matches the recorded hash,
 * false if it has drifted since the golden was last verified. */
export function checkSkillDrift(c, repoRoot) {
  if (!c.skill || !c.skillHash) return null;
  const skillPath = join(repoRoot, c.skill);
  if (!existsSync(skillPath)) return null;
  return hashFile(skillPath) === c.skillHash;
}

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
      model: process.env.HYPERION_LLM_MODEL || DEFAULT_ANTHROPIC_MODEL,
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
      model: process.env.HYPERION_LLM_MODEL || DEFAULT_OPENAI_MODEL,
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
  let stale = 0;

  for (const c of cases) {
    const goldenPath = join(goldenDir, c.golden || `${c.id}.txt`);
    if (!existsSync(goldenPath)) {
      console.error(`FAIL ${c.id}: golden missing ${goldenPath.replace(root + "\\", "").replace(root + "/", "")}`);
      failed++;
      continue;
    }
    const golden = readFileSync(goldenPath, "utf8");

    if (!live) {
      if (!scoreOutput(golden, c)) {
        failed++;
        continue;
      }
      const drifted = checkSkillDrift(c, root);
      if (drifted === false) {
        stale++;
        const message = `${c.skill} changed since this golden was last verified — the fixture may no longer represent what the skill produces. Not a hard failure; consider re-verifying (manually or with HYPERION_LLM_EVAL_LIVE=1) and updating skillHash in llm-cases.json.`;
        console.error(`WARN ${c.id}: ${message}`);
        // A plain console.error WARN is easy to miss in a green CI run — a
        // job can pass with dozens of log lines nobody reads. GitHub
        // Actions' ::warning:: workflow command surfaces this as an actual
        // annotation on the PR (checks tab + files-changed view), so drift
        // stays visible without turning this into the hard failure the
        // non-live mode deliberately avoids being.
        if (process.env.GITHUB_ACTIONS === "true") {
          console.log(`::warning file=${c.skill},title=llm-eval skill drift (${c.id})::${message}`);
        }
      }
      console.log(`OK ${c.id} (fixture schema check${drifted === false ? ", skill drifted — see WARN" : ""})`);
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
    else console.log(`OK ${c.id} (live — real model output verified)`);
  }

  const goldenCount = readdirSync(goldenDir).filter((f) => f.endsWith(".txt")).length;
  if (failed) {
    console.error(`\nllm-eval FAILED — ${failed}/${cases.length} cases`);
    ciError(
      `${failed}/${cases.length} case(s) failed (FAIL lines in the log). Each case in .github/skills/eval/llm-cases.json is checked against its golden file in .github/skills/eval/golden/ (mustContain / mustMatch); fix the golden or the case. Reproduce: npm run hyperion:llm-eval`,
      { title: "LLM eval" }
    );
    process.exit(1);
  }
  if (live) {
    console.log(`\nllm-eval OK — ${cases.length} cases verified against real model output.`);
  } else {
    console.log(
      `\nllm-eval OK — ${cases.length} cases, ${goldenCount} golden fixtures. This checked fixture consistency` +
        `${stale ? ` (${stale} skill drift WARN — see above)` : " and skill drift"}, not real model output — no LLM was called. Run with HYPERION_LLM_EVAL_LIVE=1 to actually verify against a model.`
    );
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error("llm-eval FATAL:", err.message);
    process.exit(1);
  });
}
