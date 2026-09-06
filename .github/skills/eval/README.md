# Skill eval fixtures

Two separate, deterministic-first eval systems live here — neither is an LLM judge by default.

## `hyperion:skills-eval` (structural)

Run: `npm run hyperion:skills-eval`

Reads `cases.json` — one or more cases per skill, each checking a specific,
literal contract element documented in that skill's `SKILL.md` (an output
path, a finding-ID format, an explicit rule). No API calls, no golden text —
it's a regex/string check against the skill's own documentation. Wired into
CI via `hyperion-validate.yml`.

## `hyperion:llm-eval` (golden output)

Run: `npm run hyperion:llm-eval`

Reads `llm-cases.json` — each case names a golden fixture in `golden/*.txt`
and a set of `mustContain`/`mustMatch` rules the fixture must satisfy.

- **Default (CI-safe, no API calls):** validates the committed golden files
  themselves against their rules. This catches a golden fixture drifting
  out of sync with the contract it's supposed to represent — it does **not**
  exercise a real model.
- **Live (opt-in):** `HYPERION_LLM_EVAL_LIVE=1` + `ANTHROPIC_API_KEY` (or
  `OPENAI_API_KEY`) actually prompts a real model with the matching file in
  `prompts/*.md` and scores its output against the same rules. Use this to
  check a skill's contract is actually achievable by a model, not just that
  the golden file is well-formed.
  ```bash
  HYPERION_LLM_EVAL_LIVE=1 ANTHROPIC_API_KEY=sk-ant-... npm run hyperion:llm-eval
  ```
  `HYPERION_LLM_MODEL` overrides the default model.

Adding a case: add an entry to `llm-cases.json`, a golden fixture in
`golden/`, and — if you want live mode to cover it too — a prompt in
`prompts/` with the same `id`.

Currently covers 5 skill contracts across 4 categories: `card-refiner` and
`integration-bridge` (planning/setup), `adr-generator` and
`changelog-generator` (docs), `security-audit` (quality, finding-ID format).
Each checks one literal, documented contract element (a template heading, an
ID format, a required field) — not prose quality.
