# Hyperion Agents

Agents are **long-running, multi-step flows** with human gates. Skills are reusable procedures; agents orchestrate skills, tools, and files.

**Adaptability:** all agents read `.github/project.yml` first — especially `commands.*`, `memory.*`, `outputs.*`, and `management.*`.

**Precision gates** ([definition-of-done.md](../docs/meta/definition-of-done.md)): `/execute` → `phase-verify`; `/migrate` → `project-verify`; `/pr-review` → `review-verify`; `/implement` → `plan-verify`; `/spec-review` → `spec-review-verify`; `/release` → `release-verify`; `/audit-run` → `audit-verify`. `/mentor` has no fixed artifact — human gate only, no verify script.

## When to use agent vs skill

| Use **agent** when | Use **skill** when |
|---------------------|-------------------|
| Many phases + tool use (terminal, edits) | Single artifact or checklist |
| Human approval between phases | One-shot report or doc |
| Session spans 30+ minutes | Delegable sub-step |

## Catalog

| Agent | Trigger | Role | Output |
|-------|---------|------|--------|
| **migration** | `/migrate` | Adapt Hyperion to **existing** repo | `project.yml`, memory, migration report |
| **spec-review** | `/spec-review` | Gate before coding | `.github/plans/reviews/` |
| **implementation-plan** | `/implement` | Plan + optional phased execution | `.github/plans/implementations/` |
| **implementation-executor** | `/execute` | Runs **approved plan phases** (+ tests) | Code + tests in repo |
| **pr-reviewer** | `/pr-review` | Review open PR (diff + project commands) | `.github/plans/reviews/pr-*` |
| **audit-runner** | `/audit-run` | Orchestrates 6 audit dimensions | `.github/audits/results/` |
| **release** | `/release` | Changelog, deps check, version, tag | `CHANGELOG.md`, git tag |
| **mentoring** | `/mentor` | Socratic teaching | In-chat |

## Recommended flow

```text
Legacy repo:  /migrate → /discover → /refine → …
Greenfield:   /setup → /explore → /refine → /spec → /spec-review
Delivery:     /implement → /execute → /pr-review → /audit-run → /release
```

## Adding a new agent

1. Create `{name}.agent.md` in this folder
2. Register in `.github/commands.yml` with `type: agent`
3. Run `npm run hyperion:generate-rules`
4. Document output path in `skills-output-map.md` if it writes files
