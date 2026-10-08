---
name: project-startup
description: >-
  Guided end-to-end Hyperion setup without requiring the user to run npm
  manually. Orchestrates project-discovery, memory, cards-sync bootstrap,
  and optional first audit. Use when the user says /setup, "configura o
  Hyperion", "setup completo", "primeira vez no kit", or wants everything
  initialized in one flow.
---

# Project Startup — guided Hyperion setup

One conversation to bootstrap the kit. **Prefer running terminal commands yourself**
(via Shell) so the user does not need patience for npm — explain briefly what you ran.

## Triggers

| User says | Action |
|-----------|--------|
| `/setup` | Run this skill |
| "Configura o Hyperion" / "setup completo" | Run this skill |
| "Primeira vez no kit" / "inicializa tudo" | Run this skill |

## Prerequisites (check first)

1. Hyperion present (`.github/skills/`, `.github/cards/`)
2. Node.js 20+ (`node -v`) **or** Docker (`./bin/hyperion` — see `.github/docs/meta/node-and-docker.md`)
3. For GitHub sync: `gh auth login` — if missing, guide user through
   `.github/docs/integration/github-cli-setup.md` and continue other steps

Run `npm run hyperion:doctor` (or `./bin/hyperion doctor`) and report blockers vs warnings.

## Flow (in order — pause only on blockers)

### Step 1 — Project contract

If `.github/project.yml` is missing, has no `locale`, or user asked to refresh:

1. Read and follow `.github/skills/setup/project-discovery/SKILL.md` in **Configure** mode — it **asks the team language(s) first** (suggestion from `npm run hyperion:detect-language`)
2. Write validated `project.yml` (show diff if overwriting), including `locale` and, for several languages, `languages`
3. Confirm `management.backend` (default `github` when `.github/` present)
4. Run `npm run hyperion:project-verify` — fix until exit 0 before continuing

### Step 2 — Memory (lightweight)

Suggest filling (or draft from repo evidence):

| File | Minimum |
|------|---------|
| `.github/memory/PROJECT.md` | 2–3 paragraphs: product, team, stack |
| `.github/memory/DOMAIN.md` | Key entities/flows (optional on day 1) |
| `.github/memory/DECISIONS.md` | Empty OK; note kit setup date |

Ask user for gaps you cannot infer — do not invent domain.

### Step 2b — CI/CD (non-destructive)

Read `.github/skills/setup/pipeline-architect/SKILL.md` or run:

```bash
npm run hyperion:pipeline-detect
npm run hyperion:pipeline-plan
npm run hyperion:pipeline-apply -- --yes
```

- Default `ci.policy: detect` — never overwrite existing product CI
- Persist `ci:` block in `project.yml` from detection
- If legacy `ci.yml` / `sync-cards.yml` found, migrate after user OK

### Step 3 — Cursor rules + cards bootstrap (you run npm)

**Do not ask the user to copy-paste commands** unless Shell is unavailable.

```bash
npm run hyperion:setup -- --yes
```

This installs `.cursor/rules/hyperion.mdc` (if needed) and runs cards bootstrap.

If GitHub token missing: `npm run hyperion:setup -- --skip-sync` and tell user to run
`/sync` after `gh auth login`.

Optional hook: `npm run hyperion:setup -- --yes --install-hook`

If `projects-map.json` needs manual fields, run **cards-sync-setup** skill first.

### Step 4 — First card (optional)

Offer: *"Quer refinar uma ideia em cards?"*

If yes → `.github/skills/planning/card-refiner/SKILL.md` using `CARD.template.md`.

### Step 5 — Health check offer

Offer: *"Quer uma auditoria inicial?"* → `full-audit` (one dimension at a time unless user wants full sweep).

## Output summary (always)

Report a checklist:

| Step | Status | Notes |
|------|--------|-------|
| project.yml | ✅/⚠️ | |
| ci / pipeline | ✅/⚠️ | hyperion-* workflows |
| memory/PROJECT.md | ✅/⚠️ | |
| cards bootstrap | ✅/⚠️/skipped | |
| GitHub token | ✅/⚠️ | |
| Next suggested command | `/refine`, `/audit`, `/sync` | |

## Rules

- **You run npm** — user should not need terminal literacy for setup.
- Never sync `_examples/`, `*.template.md`, or EXAMPLE/TEMPLATE/SAMPLE card IDs.
- Chat follows the person's language; files, PRs and cards follow `locale` / `languages`. Skill paths, commands and flags stay in English.
- If a step fails, fix or explain, then continue — do not restart from zero.

## Related

- Terminal ops detail: `.github/skills/setup/hyperion-ops/SKILL.md`
- Quick reference: `.github/docs/reference/comandos-rapidos.md`
- npm: `npm run hyperion:help`
