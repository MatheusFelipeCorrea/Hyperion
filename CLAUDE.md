# Hyperion — Claude Code Instructions

You have access to a full AI development kit in `.github/`. Use it.

## Context Loading

Before any task, read:
- `.github/project.yml` — project config (stack, apps, conventions)
- `.github/memory/PROJECT.md` — what this project is
- `.github/memory/DOMAIN.md` — business domain
- `.github/memory/DECISIONS.md` — decisions already made

## Available Skills

<!-- HYPERION:SKILLS:START -->
Skills live in `.github/skills/` organized by category:

- **planning/** — acceptance-spec, api-contract-guide, card-refiner, feature-flag-manager, hypothesis-forge, project-architect, refactor-guide, sprint-retro
- **setup/** — cards-sync-setup, hyperion-ops, integration-bridge, memory-capture, pipeline-architect, project-discovery, project-startup, repo-migration
- **quality/** — architecture-audit, code-review, compliance-audit, dependency-health, devops-audit, eng-metrics, full-audit, po-audit, pr-review, security-audit, tech-debt-tracker, testing-strategy, ux-audit
- **docs/** — adr-generator, changelog-generator, plantuml-generator, readme-updater, release-manager

When the user asks for any of these capabilities, read the corresponding `SKILL.md` and follow its instructions exactly.
<!-- HYPERION:SKILLS:END -->

## Agents

<!-- HYPERION:AGENTS:START -->
- `.github/agents/audit-runner.agent.md` — orchestrated 6-dimension audit (`/audit-run`)
- `.github/agents/implementation-executor.agent.md` — execute approved plan phases (`/execute`)
- `.github/agents/implementation-plan.agent.md` — phased implementation plan (`/implement`)
- `.github/agents/mentoring.agent.md` — for teaching/explaining (`/mentor`)
- `.github/agents/migration.agent.md` — adapt Hyperion to existing repo (`/migrate`)
- `.github/agents/pr-reviewer.agent.md` — review open PR diff + tests (`/pr-review`)
- `.github/agents/release.agent.md` — changelog, version, tag (`/release`)
- `.github/agents/spec-review.agent.md` — gate card/spec before coding (`/spec-review`)

See `.github/agents/README.md` for catalog and recommended flow.
<!-- HYPERION:AGENTS:END -->

## Commands Mapping

**Run npm yourself** when using `hyperion-ops` or `project-startup` — do not ask the user to paste terminal commands unless Shell is unavailable.

| User says | Read and follow |
|-----------|-----------------|
<!-- HYPERION:COMMANDS:START -->
| /help | Run `npm run hyperion:help` — list shortcuts |
| /setup | `.github/skills/setup/project-startup/SKILL.md` |
| /doctor | `.github/skills/setup/hyperion-ops/SKILL.md` → `npm run hyperion:doctor` |
| /sync | `.github/skills/setup/hyperion-ops/SKILL.md` → `npm run hyperion:sync` |
| /discover | `.github/skills/setup/project-discovery/SKILL.md` |
| /migrate | .github/agents/migration.agent.md |
| /refine | `.github/skills/planning/card-refiner/SKILL.md` |
| /explore | `.github/skills/planning/hypothesis-forge/SKILL.md` |
| /spec | `.github/skills/planning/acceptance-spec/SKILL.md` |
| /architect | `.github/skills/planning/project-architect/SKILL.md` |
| /adr | `.github/skills/docs/adr-generator/SKILL.md` |
| /audit | `.github/skills/quality/full-audit/SKILL.md` |
| /security | `.github/skills/quality/security-audit/SKILL.md` |
| /deps | `.github/skills/quality/dependency-health/SKILL.md` |
| /architecture | `.github/skills/quality/architecture-audit/SKILL.md` |
| /devops | `.github/skills/quality/devops-audit/SKILL.md` |
| /po | `.github/skills/quality/po-audit/SKILL.md` |
| /ux | `.github/skills/quality/ux-audit/SKILL.md` |
| /review | `.github/skills/quality/code-review/SKILL.md` |
| /pr-review | .github/agents/pr-reviewer.agent.md |
| /implement | .github/agents/implementation-plan.agent.md |
| /execute | .github/agents/implementation-executor.agent.md |
| /spec-review | .github/agents/spec-review.agent.md |
| /audit-run | .github/agents/audit-runner.agent.md |
| /release | .github/agents/release.agent.md |
| /mentor | .github/agents/mentoring.agent.md |
| /refactor | `.github/skills/planning/refactor-guide/SKILL.md` |
| /feature-flags | `.github/skills/planning/feature-flag-manager/SKILL.md` |
| /api-contract | `.github/skills/planning/api-contract-guide/SKILL.md` |
| /retro | `.github/skills/planning/sprint-retro/SKILL.md` |
| /test-plan | `.github/skills/quality/testing-strategy/SKILL.md` |
| /tech-debt | `.github/skills/quality/tech-debt-tracker/SKILL.md` |
| /eng-metrics | `.github/skills/quality/eng-metrics/SKILL.md` |
| /compliance | `.github/skills/quality/compliance-audit/SKILL.md` |
| /changelog | `.github/skills/docs/changelog-generator/SKILL.md` |
| /connect | `.github/skills/setup/integration-bridge/SKILL.md` |
| /cards-setup | `.github/skills/setup/cards-sync-setup/SKILL.md` |
| /readme | `.github/skills/docs/readme-updater/SKILL.md` |
| /diagram | `.github/skills/docs/plantuml-generator/SKILL.md` |
| /pipeline | `.github/skills/setup/pipeline-architect/SKILL.md` |
<!-- HYPERION:COMMANDS:END -->

Natural-language equivalents work too — see `.github/docs/reference/comandos-rapidos.md`.

## Key Principles

1. Always check `project.yml` before making assumptions about stack or conventions
2. Use memory files as persistent context across sessions
3. When generating cards, follow YAML frontmatter format from card-refiner
4. Audit reports go to `.github/audits/results/` — never edit source code during audits
5. ADRs go to `.github/docs/adr/`

## Evolving cards in conversation

When the user asks to move or update a card (e.g. "mova EXAMPLE-STORY-001 para Done"):

1. Edit the existing file in `.github/cards/` — update `status` or other frontmatter fields in place
2. Keep `card_id` unchanged; never create a duplicate file
3. Run `npm run hyperion:sync` (or validate + sync via hyperion-ops)
4. Explicit `status` in frontmatter updates the GitHub Project Status column on forward sync (other backends: metadata in issue description until native workflow mapping exists)

Allowed status: Backlog, Functional Refinement, Technical Refinement, In Progress, In Tests, In Revision, Done.

See `.github/skills/planning/card-refiner/SKILL.md` — section "Card evolution during conversation".
