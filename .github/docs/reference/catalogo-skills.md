# 🧩 Catálogo de skills Hyperion

<p align="center">
  <img src="https://img.shields.io/badge/skills-34-F5D76E?style=for-the-badge&labelColor=0B1220" alt="34 skills">
  <img src="https://img.shields.io/badge/agents-8-F5D76E?style=for-the-badge&labelColor=0B1220" alt="8 agents">
  <img src="https://img.shields.io/badge/áreas-5-2563EB?style=for-the-badge&labelColor=0B1220" alt="5 áreas">
</p>

Índice humano: **quando usar**, **comando**, **output**.

| Como estudar | Link |
|--------------|------|
| 🟢 Só os 6 comandos | [GETTING-STARTED.md](../../../GETTING-STARTED.md) |
| 🗺️ Visão no hub | [README.md](../../../README.md#skills-por-área--o-que-fazem) |
| 💬 Frases no chat | [comandos-rapidos.md](./comandos-rapidos.md) |
| 📁 Onde grava | [skills-output-map.md](./skills-output-map.md) |

**English:** [skills-catalog.md](./skills-catalog.md)

Legenda de área: 🧭 Bootstrap · 📋 Planejamento · ⚡ Entrega · 🔍 Qualidade · 📚 Docs

---

## 🧭 Bootstrap

| Skill | Comando | Quando | Output | SKILL |
|-------|---------|--------|--------|-------|
| **cards-sync-setup** | `/cards-setup` | Configurar projects-map.json | .github/cards/config/ | [SKILL.md](../../skills/setup/cards-sync-setup/SKILL.md) |
| **hyperion-ops** | `/doctor` | Doctor, sync, help via npm | *(sessão — roda npm)* | [SKILL.md](../../skills/setup/hyperion-ops/SKILL.md) |
| **integration-bridge** | `/connect` | Conectar Jira/Azure/Linear/GitLab | project.yml → management | [SKILL.md](../../skills/setup/integration-bridge/SKILL.md) |
| **memory-capture** | `—` | Registrar decisões entre sessões | .github/memory/DECISIONS.md | [SKILL.md](../../skills/setup/memory-capture/SKILL.md) |
| **pipeline-architect** | `/pipeline` | CI adaptável (hyperion-* workflows) | .github/workflows/hyperion-*.yml | [SKILL.md](../../skills/setup/pipeline-architect/SKILL.md) |
| **project-discovery** | `/discover` | Mapear repo e gerar project.yml | .github/project.yml | [SKILL.md](../../skills/setup/project-discovery/SKILL.md) |
| **project-startup** | `/setup` | Setup completo (/setup) | *(sessão — orquestrador)* | [SKILL.md](../../skills/setup/project-startup/SKILL.md) |
| **repo-migration** | `—` | Repo legado → Hyperion | .github/plans/migrations/ | [SKILL.md](../../skills/setup/repo-migration/SKILL.md) |

## 📋 Planejamento

| Skill | Comando | Quando | Output | SKILL |
|-------|---------|--------|--------|-------|
| **acceptance-spec** | `/spec` | Spec Given/When/Then de uma story | .github/plans/specs/ | [SKILL.md](../../skills/planning/acceptance-spec/SKILL.md) |
| **api-contract-guide** | `/api-contract` | Versionamento de API, breaking changes | .github/docs/api/ | [SKILL.md](../../skills/planning/api-contract-guide/SKILL.md) |
| **card-refiner** | `/refine` | Ideia → cards; mover status no board | .github/cards/ | [SKILL.md](../../skills/planning/card-refiner/SKILL.md) |
| **hypothesis-forge** | `/explore` | Explorar ideia antes de virar card | .github/memory/discoveries/ | [SKILL.md](../../skills/planning/hypothesis-forge/SKILL.md) |
| **project-architect** | `/architect` | Arquitetura greenfield | .github/docs/Project_*_Blueprint.md | [SKILL.md](../../skills/planning/project-architect/SKILL.md) |
| **refactor-guide** | `/refactor` | Plano de refactor seguro | .github/plans/implementations/ | [SKILL.md](../../skills/planning/refactor-guide/SKILL.md) |
| **sprint-retro** | `/retro` | Retrospectiva de sprint | .github/docs/retros/ | [SKILL.md](../../skills/planning/sprint-retro/SKILL.md) |

## ⚡ Entrega

| Skill | Comando | Quando | Output | SKILL |
|-------|---------|--------|--------|-------|
| **feature-flag-manager** | `/feature-flags` | Ciclo de vida de flag: rollout, kill switch, remoção | .github/docs/flags/ | [SKILL.md](../../skills/planning/feature-flag-manager/SKILL.md) |
| **pr-review** | `—` | Revisão de PR (skill) | .github/plans/reviews/pr-* | [SKILL.md](../../skills/quality/pr-review/SKILL.md) |
| **testing-strategy** | `/test-plan` | Plano de testes | .github/plans/specs/testing-strategy-*.md | [SKILL.md](../../skills/quality/testing-strategy/SKILL.md) |

## 🔍 Qualidade

| Skill | Comando | Quando | Output | SKILL |
|-------|---------|--------|--------|-------|
| **architecture-audit** | `/architecture` | Revisão de arquitetura | .github/audits/results/architecture/ | [SKILL.md](../../skills/quality/architecture-audit/SKILL.md) |
| **code-review** | `/review` | Code review pontual | .github/audits/results/code-review/ | [SKILL.md](../../skills/quality/code-review/SKILL.md) |
| **compliance-audit** | `/compliance` | Sinais técnicos LGPD/GDPR | .github/audits/results/compliance/ | [SKILL.md](../../skills/quality/compliance-audit/SKILL.md) |
| **dependency-health** | `/deps` | Audit de dependências (/deps) | .github/audits/results/dependency/ | [SKILL.md](../../skills/quality/dependency-health/SKILL.md) |
| **devops-audit** | `/devops` | Revisão DevOps/CI | .github/audits/results/devops/ | [SKILL.md](../../skills/quality/devops-audit/SKILL.md) |
| **eng-metrics** | `/eng-metrics` | Métricas DORA (deploy, lead time, MTTR) | .github/audits/results/_summary/eng-metrics-*.md | [SKILL.md](../../skills/quality/eng-metrics/SKILL.md) |
| **full-audit** | `/audit` | Auditoria 6 dimensões (/audit) | .github/audits/results/ | [SKILL.md](../../skills/quality/full-audit/SKILL.md) |
| **po-audit** | `/po` | Alinhamento de produto | .github/audits/results/product-owner/ | [SKILL.md](../../skills/quality/po-audit/SKILL.md) |
| **security-audit** | `/security` | Revisão de segurança | .github/audits/results/application-security/ | [SKILL.md](../../skills/quality/security-audit/SKILL.md) |
| **tech-debt-tracker** | `/tech-debt` | Inventário de dívida técnica | .github/docs/tech-debt-inventory.md | [SKILL.md](../../skills/quality/tech-debt-tracker/SKILL.md) |
| **ux-audit** | `/ux` | Revisão de UX | .github/audits/results/ux-design/ | [SKILL.md](../../skills/quality/ux-audit/SKILL.md) |

## 📚 Documentação

| Skill | Comando | Quando | Output | SKILL |
|-------|---------|--------|--------|-------|
| **adr-generator** | `/adr` | Architecture Decision Record | .github/docs/adr/ | [SKILL.md](../../skills/docs/adr-generator/SKILL.md) |
| **changelog-generator** | `/changelog` | Gerar CHANGELOG | CHANGELOG.md | [SKILL.md](../../skills/docs/changelog-generator/SKILL.md) |
| **plantuml-generator** | `/diagram` | Diagramas UML (/diagram) | .github/diagrams/ | [SKILL.md](../../skills/docs/plantuml-generator/SKILL.md) |
| **readme-updater** | `/readme` | Atualizar README(s) | README in repo | [SKILL.md](../../skills/docs/readme-updater/SKILL.md) |
| **release-manager** | `—` | Checklist de release | .github/plans/releases/ | [SKILL.md](../../skills/docs/release-manager/SKILL.md) |

## 🤖 Agents (fluxos longos)

| Agent | Comando | Quando | Output | Arquivo |
|-------|---------|--------|--------|-------|
| **migration** | `/migrate` | Adaptar kit a repo legado | .github/plans/migrations/ | [agent](../../agents/migration.agent.md) |
| **spec-review** | `/spec-review` | Gate de spec antes de codar | .github/plans/reviews/ | [agent](../../agents/spec-review.agent.md) |
| **implementation-plan** | `/implement` | Plano em fases | .github/plans/implementations/ | [agent](../../agents/implementation-plan.agent.md) |
| **implementation-executor** | `/execute` | Executar fase + testes | Código no repo | [agent](../../agents/implementation-executor.agent.md) |
| **pr-reviewer** | `/pr-review` | Revisar PR aberto | .github/plans/reviews/pr-* | [agent](../../agents/pr-reviewer.agent.md) |
| **audit-runner** | `/audit-run` | Auditoria orquestrada | .github/audits/results/ | [agent](../../agents/audit-runner.agent.md) |
| **release** | `/release` | Changelog, tag, release | CHANGELOG.md + tag | [agent](../../agents/release.agent.md) |
| **mentoring** | `/mentor` | Ensino socrático | *(chat)* | [agent](../../agents/mentoring.agent.md) |

