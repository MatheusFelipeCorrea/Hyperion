# 📁 Skills → Output map

Canonical registry: **every skill** and where it writes artifacts.

Override: read `project.yml` → `outputs` and `docs.*` first; fall back to paths below.

![Hyperion output map](../assets/hyperion-outputs-map.png)

---

## Planning

| Skill | Primary output | Path |
|-------|----------------|------|
| **hypothesis-forge** | Discovery bundle | `.github/memory/discoveries/{DISC-ID}/` |
| **acceptance-spec** | BDD spec folder | `.github/plans/specs/{story-id}/` |
| **card-refiner** | Sync cards + human rollup | `.github/cards/{type}/` + `.github/plans/cards/` |
| **project-architect** | Blueprints + app READMEs | `.github/docs/Project_*_Blueprint.md` + `{app}/Documents/README.md` |
| **refactor-guide** | Refactor plan | `.github/plans/implementations/refactor-{module}-{date}.md` |
| **sprint-retro** | Retro doc | `.github/docs/retros/retro-{sprint}-{date}.md` |

## Setup

| Skill | Primary output | Path |
|-------|----------------|------|
| **project-discovery** | Project contract (Configure mode) | `.github/project.yml` |
| **project-startup** | Setup checklist (in-session) | *(orchestrator — no fixed file)* |
| **hyperion-ops** | Terminal ops (in-session) | *(runs npm — no fixed file)* |
| **cards-sync-setup** | Sync config | `.github/cards/config/projects-map.json` |
| **integration-bridge** | Integration summary | `.github/memory/DECISIONS.md` + `project.yml` → `management` |
| **pipeline-architect** | CI policy + hyperion workflows | `.github/project.yml` → `ci` + `.github/workflows/hyperion-*.yml` |
| **repo-migration** | Migration report + project.yml | `.github/plans/migrations/migration-{date}.md` |
| **memory-capture** | Decision log append | `.github/memory/DECISIONS.md` (or `memory.decisions_file`) |

## Quality

| Skill | Primary output | Path |
|-------|----------------|------|
| **full-audit** | Per-dimension + summary | `.github/audits/results/<type>/` + `_summary/` |
| **architecture-audit** | Architecture report | `.github/audits/results/architecture/` |
| **security-audit** | Security report | `.github/audits/results/application-security/` |
| **devops-audit** | DevOps report | `.github/audits/results/devops/` |
| **code-review** | Code review report | `.github/audits/results/code-review/` |
| **po-audit** | Product alignment report | `.github/audits/results/product-owner/` |
| **ux-audit** | UX report | `.github/audits/results/ux-design/` |
| **testing-strategy** | Test plan | `.github/plans/specs/testing-strategy-{scope}.md` |
| **tech-debt-tracker** | Debt inventory | `.github/docs/tech-debt-inventory.md` |
| **pr-review** | PR review report | `.github/plans/reviews/pr-{id}-review.md` |
| **dependency-health** | Dependency audit | `.github/audits/results/dependency/` |

## Docs

| Skill | Primary output | Path |
|-------|----------------|------|
| **adr-generator** | ADR | `.github/docs/adr/ADR-{NNN}-{slug}.md` |
| **plantuml-generator** | Full diagram set (12 types, incl. CI/CD Pipeline via `hyperion:pipeline-diagram`) | `.github/diagrams/{category}/` — see [diagrams/README.md](../../diagrams/README.md) |
| **readme-updater** | Updated README(s) | In place at detected README/docs files (root + apps) |
| **changelog-generator** | Changelog | `CHANGELOG.md` (repo root) |
| **release-manager** | Release checklist | `.github/plans/releases/release-{version}-checklist.md` + `CHANGELOG.md` |
| **pr-writer** | PR body draft + opened PR (repo language) | `.github/plans/prs/pr-{branch}.md` |

## Agents (not skills, but produce files)

| Agent | Primary output | Path |
|-------|----------------|------|
| **spec-review** | Spec gate report | `.github/plans/reviews/{card-id}-review.md` |
| **implementation-plan** | Phased plan | `.github/plans/implementations/{card-id}-plan.md` |
| **implementation-executor** | Code + tests | In repo (uses `commands.test`) |
| **pr-reviewer** | PR review report | `.github/plans/reviews/pr-*-review.md` |
| **migration** | Migration report | `.github/plans/migrations/migration-{date}.md` |
| **audit-runner** | Orchestrated audit bundle | `.github/audits/results/` |
| **release** | Changelog + tag checklist | `CHANGELOG.md`, git tag |
| **mentoring** | *(none by default)* | In-chat only; may point to existing docs |

## Scripts (not skills)

| Script | Primary output | Path |
|--------|----------------|------|
| **cards-sync** | Last sync log | `.github/plans/cards/last-sync.md` |

---

## Folder tree (created in kit)

```
.github/
├── cards/              ← card-refiner (sync source)
├── plans/
│   ├── cards/          ← card-refiner rollup + last-sync.md
│   ├── specs/          ← acceptance-spec, testing-strategy
│   ├── reviews/        ← spec-review, pr-reviewer
│   ├── prs/            ← pr-writer
│   ├── migrations/     ← migration agent, repo-migration
│   ├── releases/       ← release-manager, release agent
│   └── implementations/← implementation-plan, refactor-guide
├── memory/
│   └── discoveries/    ← hypothesis-forge
├── docs/
│   ├── adr/            ← adr-generator
│   └── retros/         ← sprint-retro
├── diagrams/           ← plantuml-generator
└── audits/results/     ← *-audit skills
```

---

## Customization

In `.github/project.yml`:

```yaml
outputs:
  audits: .github/audits/results
  cards: .github/plans/cards
  implementations: .github/plans/implementations
  diagrams: .github/diagrams

docs:
  blueprints: .github/docs
  diagrams: .github/diagrams
```

Full user guide: [onde-ficam-os-outputs.md](../meta/onde-ficam-os-outputs.md) · **Catalog:** [catalogo-skills.md](./catalogo-skills.md) · [skills-catalog.md](./skills-catalog.md)
