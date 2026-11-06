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

Reads `llm-cases.json` — each case names a golden fixture in `golden/*.txt`,
a set of `mustContain`/`mustMatch` rules the fixture must satisfy, and
(optionally) a `skill` path + `skillHash`.

- **Default (CI-safe, no API calls — this is what `hyperion-validate.yml`
  always runs):** does two things, and it matters that neither one is "an
  LLM eval":
  1. Validates the committed golden file against its own rules — catches a
     fixture drifting out of sync with the contract it's supposed to
     represent.
  2. If the case has a `skill`/`skillHash`, re-hashes the referenced
     `SKILL.md` and compares it to the hash recorded when the golden was
     last verified. A mismatch prints a `WARN` (not a hard failure — an
     edited skill isn't proof the golden is wrong, only that nobody's
     confirmed it since) telling you to re-verify and update `skillHash`.
  **Neither check calls a model.** Because CI never sets
  `HYPERION_LLM_EVAL_LIVE`, "llm-eval passing" in CI has never meant "a real
  LLM still produces acceptable output" — only that the golden fixtures are
  internally consistent and none of their skills silently changed out from
  under them since last verified. Worth knowing before treating a green
  `hyperion:llm-eval` as evidence of anything about actual model behavior.
- **Live (opt-in, the only mode that actually exercises a model):**
  `HYPERION_LLM_EVAL_LIVE=1` + `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`)
  prompts a real model with the matching file in `prompts/*.md` and scores
  its output against the same rules.
  ```bash
  HYPERION_LLM_EVAL_LIVE=1 ANTHROPIC_API_KEY=sk-ant-... npm run hyperion:llm-eval
  ```
  `HYPERION_LLM_MODEL` overrides the default model. Not wired into any
  scheduled CI job — that would need a maintainer decision on a real API
  key/budget, a separate call from this eval mechanism existing.

Adding a case: add an entry to `llm-cases.json` (`skill` + `skillHash` —
`node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('<path>','utf8')).digest('hex'))"`
— are optional but recommended so a future skill edit gets flagged), a
golden fixture in `golden/`, and — if you want live mode to cover it too —
a prompt in `prompts/` with the same `id`. When you deliberately change a
skill a case references, re-verify the golden still holds and update its
`skillHash` — that's the whole point of the check.

Currently covers 5 skill contracts across 4 categories: `card-refiner` and
`integration-bridge` (planning/setup), `adr-generator` and
`changelog-generator` (docs), `security-audit` (quality, finding-ID format).
Each checks one literal, documented contract element (a template heading, an
ID format, a required field) — not prose quality.
