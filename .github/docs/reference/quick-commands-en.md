# 💬 Hyperion quick commands

Single reference for **npm** (terminal) and **the AI chat** (no terminal).

| Level | Read |
|-------|------|
| 🟢 | [Minimum kit](#minimum-kit-first-week) — 6 commands |
| 🟡 | [Prefer the agent](#prefer-the-agent) — chat phrases |
| 🔵 | [npm one-liners](#npm--one-liners) — CI and power users |

**Português:** [comandos-rapidos.md](./comandos-rapidos.md)

---

## 🟢 Minimum kit (first week)

Type in **chat**, not the terminal. Slash works in Claude Code; in Cursor the equivalent phrase also works.

| Order | Command | Level |
|-------|---------|-------|
| 1 | **`/setup`** (new repo) or **`/migrate`** (existing code) | 🟢 |
| 2 | **`/doctor`** | 🟢 |
| 3 | **`/refine`** | 🟢 |
| 4 | **`/implement`** → **`/execute`** | 🟡 |
| 5 | **`/help`** | 🟢 |

`/discover` ≠ `/explore` ≠ `/migrate`: discover only maps `project.yml`; explore is product hypothesis; migrate adapts the kit to a legacy repo.

`/audit` (skill, 6 dimensions) vs **`/audit-run`** (same content, agent with gates). Prefer `/audit` day-to-day.

---

## Prefer the agent

With Cursor, Copilot, or Claude Code, **you do not need npm**. Say:

| Say this | What happens |
|----------|--------------|
| **`/setup`** or *"Set up Hyperion in this repo"* | Guided full setup (`project-startup`) |
| **`/doctor`** or *"Run Hyperion doctor"* | Kit + cards health check |
| **`/sync`** or *"Sync the cards"* | Validate and push cards to GitHub |
| **`/discover`** or *"Discover this project"* | Map repo, create/refresh `project.yml` |
| **`/migrate`** or *"Adapt Hyperion to this repo"* | Legacy repo → project.yml + memory |
| **`/refine`** or *"Refine into cards"* | Structured cards |
| **`/audit`** or *"Full repo audit"* | Six audit dimensions |
| **`/review`** | Code review |
| **`/pr`** | Open a PR in the repo language (`locale`; multilingual when `languages` has more than one) |
| **`/pr-review`** | Open PR review (diff + tests) |
| **`/deps`** | Dependency health (audit + outdated) |
| **`/implement`** | Implementation plan for a card |
| **`/execute`** | Run approved plan phase (+ tests) |
| **`/spec-review`** | Spec/card gate before coding |
| **`/audit-run`** | Orchestrated audit (6 dimensions) |
| **`/release`** | Changelog, version bump, tag |
| **`/diagram`** or *"Full diagram package"* | 11 UML types under `.github/diagrams/` |
| **`/spec`** | BDD spec + optional per-story flowchart |
| **`/help`** or *"List Hyperion commands"* | Show shortcuts |

Slash commands work natively in **Claude Code** (`CLAUDE.md`). In **Cursor**, use phrases or slashes — `.cursor/rules/hyperion.mdc` maps the same triggers.

---

## npm one-liners

**Node 20+** at repo root **or** `./bin/hyperion` (Docker) — [node-and-docker-en.md](../meta/node-and-docker-en.md).

```bash
npm run hyperion:help              # list all
npm run hyperion:doctor            # kit + cards health
npm run hyperion:setup -- --yes    # full cards bootstrap
npm run hyperion:sync              # validate + sync
npm run hyperion:sync -- --dry-run # simulate only
npm run hyperion:phase-verify -- --plan <path>
npm run hyperion:project-verify
npm run hyperion:review-verify -- --review <path>
npm run hyperion:cli -- doctor     # unified CLI
npm run hyperion:upgrade                          # GitHub origin: check + plan
npm run hyperion:upgrade -- --yes                 # fetch origin + apply
npm run hyperion:upgrade -- --check               # exit 1 if behind
npm run hyperion:upgrade -- --from <kit> --yes    # offline / local path
./bin/hyperion doctor                             # native Node or Docker
npm run hyperion:docker-build                     # hyperion-cli image
```

Gates: [definition-of-done.md](../meta/definition-of-done.md). No Node: [node-and-docker-en.md](../meta/node-and-docker-en.md).

### First time (GitHub)

```bash
gh auth login
npm run hyperion:setup -- --yes
# or ask the agent: /setup
```

### Day to day

```bash
npm run hyperion:sync
npm run cards:watch                # optional auto-sync on save
```

---

## Audits (agent only)

Audits are **read-only** — reports go to `.github/audits/results/`.

| Phrase | Skill |
|--------|-------|
| *"Full audit"* | `full-audit` |
| *"Security review"* | `security-audit` |
| *"Architecture review"* | `architecture-audit` |
| *"DevOps review"* | `devops-audit` |
| *"Code review"* | `code-review` |
| *"Product alignment"* | `po-audit` |
| *"UX review"* | `ux-audit` |

Guide: [first-audit-en.md](../quality/first-audit-en.md)

---

## Diagrams (`/diagram`)

Skill `plantuml-generator` — writes `.puml` / `.mmd` sources (PNG export is manual).

| Say this | Result |
|----------|--------|
| **`/diagram`** + *"Complete package"* | 12 diagrams in recommended order (approval between each) |
| *"Sequence diagram for login"* | `Sequencia/sequencia-login.puml` |
| *"ER model for the database"* | `Modelo de Dados/modelo-dados.puml` |
| *"Order state machine"* | `Estado/estado-pedido.puml` |

Types: use case, components, packages, classes, ER, deployment, data flow, sequence, activity, state, C4 prompt.

Full map: [diagrams/README.md](../../diagrams/README.md) · [where-outputs-go-en.md](../meta/where-outputs-go-en.md)

---

## Keeping commands in sync

| Source | Role |
|--------|------|
| **`.github/commands.yml`** | Canonical registry of phrases, skills, and npm scripts |
| `npm run hyperion:generate-rules` | Regenerates `help.mjs`, `CLAUDE.md`, `hyperion.mdc`, `copilot-instructions.md` |
| `npm run hyperion:check-rules` | CI — fails if runtime rules drift from `commands.yml` |
| `package.json` | npm scripts (`hyperion:*`, `cards:*`) |
| `scripts/hyperion/help.mjs` | `hyperion:help` output (generated) |
| `project-startup` / `hyperion-ops` skills | Guided setup and terminal ops |
| `.github/audits/manifest.yml` | Audit types |

**Only if you contribute to the Hyperion repository:** edit `commands.yml` → `npm run hyperion:generate-rules` → commit. See [CONTRIBUTING.md](../../../CONTRIBUTING.md).

---

## See also

- [setup-github-en.md](../onboarding/setup-github-en.md)
- [scripts/cards-sync/README.md](../../../scripts/cards-sync/README.md)
