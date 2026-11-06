---
name: hypothesis-forge
description: >-
  Guided problem exploration session. Helps Product/Design understand the
  problem before jumping to solutions. Outputs a structured decision
  (Build/Validate/Defer/Discard) stored in .github/memory/discoveries/.
  Use before writing specs or cards — when you don't yet know exactly what
  to build.
---

# Hypothesis Forge — Problem Exploration

## When to use

- Before any spec or card — when the problem is unclear
- When someone brings a solution without a clear problem statement
- When evaluating whether something is worth building
- When prioritizing between competing ideas

## Context (read first)

1. `.github/memory/PROJECT.md` — project context and glossary
2. `.github/memory/DOMAIN.md` — existing entities and flows
3. `.github/memory/discoveries/` — previous discoveries (patterns and learnings)

## Phase 1 — Problem

Conduct a conversation to understand the problem. Ask **one question at a time**:

1. **Who has the problem?** — Which specific persona feels this pain? Be precise.
2. **What is the problem today?** — Describe the current situation. What fails, is slow, or frustrating?
3. **Why does it matter now?** — What is the impact? Financial, operational, experiential?
4. **How is it being solved today?** — Workarounds? Spreadsheets? Manual processes?

After gathering answers, write `.github/memory/discoveries/{DISC-ID}/problem.md`:

```markdown
# Problem — {DISC-ID}

## Persona
[Who]

## Current Situation
[What happens today]

## Impact
[Why it matters]

## Current Workarounds
[How they cope]
```

**STOP**: "Is the problem clear enough to formulate a hypothesis?"

## Phase 2 — Hypothesis

Formalize what we believe will solve the problem:

```
We believe that [feature/change]
will solve [specific problem]
for [persona]
and we will know it worked when [observable metric].
```

Then identify:
- **Critical assumptions**: What must be true for this to work? Top 3.
- **Biggest risk**: Which assumption, if false, invalidates everything?
- **Minimum scope**: Smallest version that validates or refutes the hypothesis.

Write `.github/memory/discoveries/{DISC-ID}/hypothesis.md`.

**STOP**: "Is the hypothesis clear? Which assumptions need validation before building?"

## Phase 3 — Decision

Based on problem + hypothesis, decide:

| Decision | When | Next step |
|----------|------|-----------|
| **Build** | Clear hypothesis, acceptable assumptions, confirmed priority | Create card or spec referencing this discovery |
| **Validate first** | Critical assumption uncertain — needs research or experiment | Register experiment; revisit with data |
| **Defer** | Valid, but not now — capacity or dependency issue | Register review condition |
| **Discard** | Problem isn't real, hypothesis refuted, or out of scope | Register reason |

Write `.github/memory/discoveries/{DISC-ID}/decision.md`.

If **Build**: suggest running `card-refiner` or `acceptance-spec` skill next, referencing this discovery.

## Output

```
.github/memory/discoveries/{DISC-ID}/
├── problem.md
├── hypothesis.md
└── decision.md
```

Naming: `DISC-{NNN}-{slug}` (e.g. `DISC-001-user-onboarding-friction`)

## Rules

- Do not jump to solutions. If someone brings a solution, ask: "What problem does this solve?"
- One discovery per DISC-ID. Do not mix different problems.
- Discovery is valid even if the decision is Discard — knowledge is preserved.
- "Build" without a clear hypothesis means the discovery isn't done.
- Talk with the person in their language; the saved discovery file uses the primary `locale` from `.github/project.yml`.
