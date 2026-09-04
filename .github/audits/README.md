# Audits

Registry and prompts for read-only repository audits. Reports are written under `results/` (gitignored except `.gitkeep`).

## Layout

| Path | Role |
|------|------|
| [`manifest.yml`](./manifest.yml) | Source of truth: audit type → skill → prompt → output dir |
| [`prompts/`](./prompts/) | Persona protocols (generic checklists) |
| [`prompts/README.md`](./prompts/README.md) | How to invoke audits |
| [`overlays/`](./overlays/) | Optional domain context (`project.yml` → `audits.overlay`) |
| [`results/`](./results/) | Generated reports (runtime) |

## Quick start

Ask the agent: **`/audit`** or *"Auditoria completa do repositório"* → skill `full-audit`.

Single dimension: `/security`, `/architecture`, `/devops`, `/review`, `/po`, `/ux`.

Ran `/audit-run` before? Compare this round against the last one, dimension by dimension:

```bash
npm run hyperion:audit-diff              # two most recent audit-run-*.md summaries under results/_summary/
npm run hyperion:audit-diff -- --json
npm run hyperion:audit-diff -- --from results/_summary/audit-run-2026-08-01.md --to results/_summary/audit-run-2026-08-21.md
```

It reads the same "## Reports" table `hyperion:audit-verify` already requires every summary to have, parses each dimension's `Findings` cell for severity counts (`"2 high, 1 medium"`), and reports which dimensions got better, worse, unchanged, or are new/removed since the last round.

Commands reference: [comandos-rapidos.md](../docs/reference/comandos-rapidos.md) · First audit guide: [primeira-auditoria.md](../docs/quality/primeira-auditoria.md)

## Rules

- Audits are **read-only** — no source edits.
- Phased audits: one phase per session unless user asks for unattended run.
- Product paths and stack come from [`../project.yml`](../project.yml), not from prompts alone.
