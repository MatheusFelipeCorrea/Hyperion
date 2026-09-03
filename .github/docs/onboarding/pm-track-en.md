# PM / Product Owner track

**Persona:** PM, PO, or business analyst — needs cards, board, and visibility **without** diving into CI or scripts.

| Step | Command / action | Time |
|------|-------------------|------|
| 1 | Read [GETTING-STARTED.md](../../../GETTING-STARTED.md) — glossary + overview | 10 min |
| 2 | Ask a dev to: copy the kit + `npm install` + `/setup` | — |
| 3 | **`/refine`** — create/refine cards in business language | 15 min |
| 4 | **`/sync`** — publish to GitHub Projects (via a dev or ops agent) | 5 min |
| 5 | Follow the board: status, POC/Prototype/Spike labels | ongoing |

## What to ignore in month 1

- `project.schema.json`, `hyperion:pipeline-*`, Docker, SBOM
- `cards-sync/backends/` details — only relevant if migrating off GitHub to Jira/Linear

## Labels useful for a PM

| Label | When to use |
|-------|-------------|
| POC | Validate a value hypothesis |
| Prototype | Align on UX before the build |
| Spike | Time-boxed technical research |
| Customer request | Externally traceable ask |

See the decision tree in [card-refiner SKILL](../../skills/planning/card-refiner/SKILL.md).

**Português:** [trilha-pm.md](./trilha-pm.md)

**Back:** [learning-path-en.md](./learning-path-en.md)
