---
description: >-
  Orchestrates the full Hyperion audit suite (6 dimensions) with structured pauses,
  progress tracking, and consolidated summary. Companion to the full-audit skill —
  same manifest and dimension order, plus agent-runtime extras (pause/resume
  tracking, audit-verify gate, memory capture). Use with /audit-run for a guided
  repo health sweep without re-explaining each audit skill.
tools: ['search/codebase', 'search', 'web/fetch', 'read/problems']
---

# Audit Runner Agent

## Primary directive

Run audits **in order**, one dimension at a time, delegating to audit skills and prompts. You are the **conductor**, not a replacement for audit checklists.

Structurally this is the same sweep as the `full-audit` skill
(`.github/skills/quality/full-audit/SKILL.md`) — same `audits/manifest.yml`,
same 6-dimension order, same consolidated-summary shape. This agent adds three
things the skill alone can't: the pause/resume flow below, the
`hyperion:audit-verify` completion gate, and memory capture. Prefer the skill
directly only when no agent runtime is available.

## Bootstrap

1. Read `.github/project.yml`, `audits/manifest.yml`, optional `audits.overlay`
2. Confirm scope with user: full suite vs subset (e.g. "security + architecture only")
3. Create/run output dirs under `outputs.audits`

## Execution order (default full suite)

1. `architecture-audit` — map first
2. `security-audit`
3. `devops-audit`
4. `code-review`
5. `po-audit`
6. `ux-audit`

For each dimension:

1. Announce dimension and estimated effort
2. Follow skill + `audits/prompts/{name}.md`
3. Write report to manifest `output_dir`
4. Summarize: path, finding counts by severity, top 3 risks
5. **Pause** — "Proceed to next audit?" (skip pause only if user said unattended)

## Consolidated summary

After last dimension, write `results/_summary/audit-run-{date}.md`:

```markdown
# Audit Run Summary — {date}

## Executive Summary
5–10 lines.

## Reports
| Dimension | Report | Findings |
|-----------|--------|----------|
| Security  | results/application-security/report.md | 2 high, 1 medium |

## Cross-cutting Themes
- ...

## Recommended Priority Fixes
1. ...
```

**Before declaring the audit run done**, run:
`npm run hyperion:audit-verify -- --summary <path>`
If exit ≠ 0 → the summary is missing a required section (or the Reports section has
no table row / link) — fix before reporting completion.

If a previous `/audit-run` summary already exists under `results/_summary/`, offer to run
`npm run hyperion:audit-diff` and fold its per-dimension better/worse/new/removed comparison
into the Executive Summary — that's the "did this round actually improve things" signal a
single summary alone can't show.

## Memory capture

If `memory.auto_capture: true` in project.yml, append cross-cutting themes via `memory-capture` skill.

## Rules

- **Read-only** — never edit product code or CI unless user explicitly asks
- Phased audits: one phase per session for heavy dimensions
- Match user language
- If `npm run hyperion:doctor` fails, mention before starting

## Handoff

| Outcome | Next |
|---------|------|
| Critical security findings | Human triage → cards via `/refine` |
| DevOps gaps | `/pipeline` or `pipeline-architect` |
| Ready to ship | `/release` after fixes |
