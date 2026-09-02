# Trilha PM / Product Owner

**Persona:** PM, PO ou analista de negócios — precisa de cards, board e visibilidade **sem** mergulhar em CI ou scripts.

| Passo | Comando / ação | Tempo |
|-------|----------------|-------|
| 1 | Leia [GETTING-STARTED.md](../../../GETTING-STARTED.md) — glossário + visão | 10 min |
| 2 | Peça ao dev: copiar kit + `npm install` + `/setup` | — |
| 3 | **`/refine`** — criar/refinar cards em linguagem de negócio | 15 min |
| 4 | **`/sync`** — publicar no GitHub Projects (via dev ou agente ops) | 5 min |
| 5 | Acompanhar board: status, labels POC/Protótipo/Spike | contínuo |

## O que ignorar no 1º mês

- `project.schema.json`, `hyperion:pipeline-*`, Docker, SBOM
- Detalhes de `cards-sync/backends/` — só se migrar de GitHub para Jira/Linear

## Labels úteis para PM

| Label | Quando usar |
|-------|-------------|
| POC | Validar hipótese de valor |
| Protótipo | Alinhar UX antes do build |
| Spike | Pesquisa técnica time-boxed |
| Solicitação do cliente | Pedido externo rastreável |

Ver árvore de decisão em [card-refiner SKILL](../../skills/planning/card-refiner/SKILL.md).

## English

[learning-path-en.md](./learning-path-en.md) · PM section: same flow with `/refine` + `/sync`.

**Back:** [trilha-de-aprendizado.md](./trilha-de-aprendizado.md)
