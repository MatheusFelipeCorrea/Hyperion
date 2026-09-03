---
name: full-audit
description: >-
  Runs the complete audit suite (Product Owner, Security, DevOps, Code Review,
  UX, Architecture) in sequence, one dimension at a time, and writes a
  consolidated summary. Companion to audit-runner agent — use this standalone
  when the runtime has no agent support. Use when the user asks for a
  full/complete repository audit, a health check, or an audit sweep.
---

# Full Audit — orchestrated repo sweep

Coordinates the six audit skills defined in `.github/audits/manifest.yml`. It does
not re-implement their checklists; it **runs each one in order** and aggregates
results. Heavy, so it works dimension-by-dimension and pauses for the user.

**Companion to the `audit-runner` agent** (`.github/agents/audit-runner.agent.md`,
`/audit-run`) — same manifest, same dimension order, same consolidated-summary
shape. Use this skill directly when the runtime has no agent support, or as a
sub-step inside another flow; prefer `/audit-run` when an agent runtime is
available, since it also gates completion on `hyperion:audit-verify` and can
capture cross-cutting themes to memory.

## Step 1 — Context

**Prefer reading `.github/project.yml`.** Only run `project-discovery` (Context mode) if the contract is missing or paths are stale. Capture apps, docs, `outputs.audits`, locale, and any `audits.overlay`. Never invent paths.

## Step 2 — Read the manifest

Read `.github/audits/manifest.yml` to get, for each audit: `skill`, `prompt`,
`output_dir`, `id_prefix`, and whether it is `phased`. Run audits in this order
(dependency-friendly):

1. `architecture-audit` — structural map first (context for the rest)
2. `security-audit`
3. `devops-audit`
4. `code-review`
5. `po-audit`
6. `ux-audit`

## Step 3 — Run each audit

For every audit:

- Delegate to its skill, following `audits/prompts/<name>.md` (+ overlay if set).
- Save the report under `outputs.audits`/`<output_dir>` (create dirs as needed).
- For **phased** audits, run **one phase per session** and wait for the user's OK
  before the next phase — do not attempt all phases at once.
- After each audit, report: file path, count of findings by severity, top risks.

**Pause between audits.** Ask "Proceed to the next audit?" unless the user asked
to run everything unattended.

## Step 4 — Consolidated summary

After the suite (or the subset the user scoped), write one roll-up under
`outputs.audits` (e.g. `results/_summary/full-audit-<date>.md`):

- Table: audit → report link → findings by severity → confidence
- Cross-cutting themes appearing in multiple audits
- Prioritized, de-duplicated action list (Critical → High → Medium → Low)
- Links to each detailed report

## Output

| Artifact | Path |
|----------|------|
| Per-dimension reports | `project.yml` → `outputs.audits` / `<output_dir>` from `manifest.yml` |
| Fallback per report | `.github/audits/results/<type>/` |
| Consolidated summary | `.github/audits/results/_summary/full-audit-<date>.md` |

Suggested per-dimension filenames follow each audit skill (e.g. `arch-fase-1-dominio-dados.md`). **Read-only** — no source edits.

## Rules

- **Read-only.** No code/doc edits — audits produce reports only.
- Respect each audit's own scope rules; cite evidence as `path:line`.
- Skip a dimension (mark N/A) when the repo has nothing relevant, instead of forcing findings.
- Output language from `project.yml` / user preference.

## Scope control

The user may narrow scope: "full audit of the `web` app only" or "just security +
architecture". Honor it and only run/aggregate the requested subset.

## Example

> "Do a complete audit of the repo." → discovery → read manifest → run
> architecture → (OK) → security → … → write consolidated summary.
