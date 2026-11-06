# Diagrams (PlantUML + Mermaid)

This folder is **generated on demand** — it is empty in a fresh Hyperion clone.

## When files appear here

| Trigger | Skill | Output pattern |
|---------|-------|----------------|
| `/diagram` · *"Gera diagramas"* · *"Pacote completo de diagramas"* | `plantuml-generator` | `{category}/*.puml`, optional `*.mmd` |
| `npm run hyperion:pipeline-diagram -- --write` · `/pipeline` (offer after preview) | `pipeline-diagram.mjs` (deterministic) | `Pipeline/*.mmd` + `Pipeline/*.puml` + `Pipeline/README.md` |

## Complete diagram set (12 types)

| # | Type | Folder | Example file |
|---|------|--------|--------------|
| 1 | Use Case | `Caso de Uso/` | `caso-de-uso.puml` |
| 2 | Component | `Componentes/` | `componentes.puml` |
| 3 | Package | `Pacotes/` | `pacotes-frontend.puml`, `pacotes-backend.puml` |
| 4 | Class (backend) | `Classes/` | `classes.puml` |
| 5 | ER / Data model | `Modelo de Dados/` | `modelo-dados.puml` |
| 6 | Deployment | `Implantacao/` | `implantacao.puml` |
| 7 | Data Flow | `Fluxo de Dados/` | `fluxo-dados.puml` |
| 8 | Sequence | `Sequencia/` | `sequencia-{operacao}.puml` |
| 9 | Activity | `Atividade/` | `atividade-{processo}.puml` |
| 10 | State | `Estado/` | `estado-{entidade}.puml` |
| 11 | Pipeline (CI/CD) | `Pipeline/` | `pipeline-gates.mmd`, `workflow-{name}.puml` |
| 12 | C4 L2 prompt | `Arquitetura/` | `prompt-arquitetura.md` |

The Pipeline diagrams come from a script, not the LLM: it parses `ci.gates` (as `pipeline-apply --refresh-gates` would render it) and every `.github/workflows/*.yml`. That gives a Triggers node, jobs connected by `needs`, and each job's run condition, matrix, services and gate steps. Colors: red = block, amber dashed = warn, purple = publish/deploy.

Per-story flowcharts from `/spec` live separately in `.github/plans/specs/{story-id}/blueprint.mermaid`.

## Prerequisites (optional)

Diagrams work best when project docs exist; the skill falls back to READMEs, specs, and codebase discovery:

- `.github/docs/Project_Architecture_Blueprint.md` — from `project-architect`
- `.github/docs/Project_Folders_Structure_Blueprint.md` — from `project-architect`
- `.github/plans/specs/` — from `acceptance-spec` (sequence/activity/state hints)
- App READMEs, migrations/ORM schema, `project.yml`

## Export PNG/SVG

Sources are `.puml` / `.mmd`. Render locally:

```bash
npx @mermaid-js/mermaid-cli -i diagram.mmd -o diagram.png
# PlantUML: java -jar plantuml.jar file.puml
```

Or use [mermaid.live](https://mermaid.live) / PlantUML online server.

## Related docs

- [plantuml-generator skill](../skills/docs/plantuml-generator/SKILL.md)
- [where-outputs-go-en.md](../docs/meta/where-outputs-go-en.md)
- [onde-ficam-os-outputs.md](../docs/meta/onde-ficam-os-outputs.md)
