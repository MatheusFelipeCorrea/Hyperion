# 🧩 Hyperion skills catalog

<p align="center">
  <img src="https://img.shields.io/badge/skills-34-F5D76E?style=for-the-badge&labelColor=0B1220" alt="34 skills">
  <img src="https://img.shields.io/badge/agents-8-F5D76E?style=for-the-badge&labelColor=0B1220" alt="8 agents">
</p>

Human index: **when**, **command**, **output**.

| Study path | Link |
|------------|------|
| 🟢 Six commands | [GETTING-STARTED.md](../../../GETTING-STARTED.md) |
| 🗺️ Hub overview | [README.md](../../../README.md) |
| 💬 Chat phrases | [quick-commands-en.md](./quick-commands-en.md) |

**Português:** [catalogo-skills.md](./catalogo-skills.md) · Areas: 🧭 Bootstrap · 📋 Planning · ⚡ Delivery · 🔍 Quality · 📚 Docs

---

## 🧭 Bootstrap

| Skill | Command | When | Output | SKILL |
|-------|---------|--------|--------|-------|
| **cards-sync-setup** | `/cards-setup` | Configure projects-map.json | .github/cards/config/ | [SKILL.md](../../skills/setup/cards-sync-setup/SKILL.md) |
| **hyperion-ops** | `/doctor` | Doctor, sync, help via npm | *(sessão — roda npm)* | [SKILL.md](../../skills/setup/hyperion-ops/SKILL.md) |
| **integration-bridge** | `/connect` | Connect Jira/Azure/Linear/GitLab | project.yml → management | [SKILL.md](../../skills/setup/integration-bridge/SKILL.md) |
| **memory-capture** | `—` | Log decisions across sessions | .github/memory/DECISIONS.md | [SKILL.md](../../skills/setup/memory-capture/SKILL.md) |
| **pipeline-architect** | `/pipeline` | Adaptive CI (hyperion-* workflows) | .github/workflows/hyperion-*.yml | [SKILL.md](../../skills/setup/pipeline-architect/SKILL.md) |
| **project-discovery** | `/discover` | Map repo and create project.yml | .github/project.yml | [SKILL.md](../../skills/setup/project-discovery/SKILL.md) |
| **project-startup** | `/setup` | Full setup (/setup) | *(sessão — orquestrador)* | [SKILL.md](../../skills/setup/project-startup/SKILL.md) |
| **repo-migration** | `—` | Legacy repo → Hyperion | .github/plans/migrations/ | [SKILL.md](../../skills/setup/repo-migration/SKILL.md) |

## 📋 Planning

| Skill | Command | When | Output | SKILL |
|-------|---------|--------|--------|-------|
| **acceptance-spec** | `/spec` | BDD spec for a story | .github/plans/specs/ | [SKILL.md](../../skills/planning/acceptance-spec/SKILL.md) |
| **api-contract-guide** | `/api-contract` | API versioning, breaking changes | .github/docs/api/ | [SKILL.md](../../skills/planning/api-contract-guide/SKILL.md) |
| **card-refiner** | `/refine` | Idea → cards; move board status | .github/cards/ | [SKILL.md](../../skills/planning/card-refiner/SKILL.md) |
| **hypothesis-forge** | `/explore` | Explore an idea before cards | .github/memory/discoveries/ | [SKILL.md](../../skills/planning/hypothesis-forge/SKILL.md) |
| **project-architect** | `/architect` | Greenfield architecture | .github/docs/Project_*_Blueprint.md | [SKILL.md](../../skills/planning/project-architect/SKILL.md) |
| **refactor-guide** | `/refactor` | Safe refactor plan | .github/plans/implementations/ | [SKILL.md](../../skills/planning/refactor-guide/SKILL.md) |
| **sprint-retro** | `/retro` | Sprint retrospective | .github/docs/retros/ | [SKILL.md](../../skills/planning/sprint-retro/SKILL.md) |

## ⚡ Delivery

| Skill | Command | When | Output | SKILL |
|-------|---------|--------|--------|-------|
| **feature-flag-manager** | `/feature-flags` | Flag lifecycle: rollout, kill switch, removal | .github/docs/flags/ | [SKILL.md](../../skills/planning/feature-flag-manager/SKILL.md) |
| **pr-review** | `—` | PR review (skill) | .github/plans/reviews/pr-* | [SKILL.md](../../skills/quality/pr-review/SKILL.md) |
| **testing-strategy** | `/test-plan` | Testing strategy | .github/plans/specs/testing-strategy-*.md | [SKILL.md](../../skills/quality/testing-strategy/SKILL.md) |

## 🔍 Quality

| Skill | Command | When | Output | SKILL |
|-------|---------|--------|--------|-------|
| **architecture-audit** | `/architecture` | Architecture review | .github/audits/results/architecture/ | [SKILL.md](../../skills/quality/architecture-audit/SKILL.md) |
| **code-review** | `/review` | Ad-hoc code review | .github/audits/results/code-review/ | [SKILL.md](../../skills/quality/code-review/SKILL.md) |
| **compliance-audit** | `/compliance` | LGPD/GDPR technical signals | .github/audits/results/compliance/ | [SKILL.md](../../skills/quality/compliance-audit/SKILL.md) |
| **dependency-health** | `/deps` | Dependency audit (/deps) | .github/audits/results/dependency/ | [SKILL.md](../../skills/quality/dependency-health/SKILL.md) |
| **devops-audit** | `/devops` | DevOps/CI review | .github/audits/results/devops/ | [SKILL.md](../../skills/quality/devops-audit/SKILL.md) |
| **eng-metrics** | `/eng-metrics` | DORA metrics (deploy, lead time, MTTR) | .github/audits/results/_summary/eng-metrics-*.md | [SKILL.md](../../skills/quality/eng-metrics/SKILL.md) |
| **full-audit** | `/audit` | Six-dimension audit (/audit) | .github/audits/results/ | [SKILL.md](../../skills/quality/full-audit/SKILL.md) |
| **po-audit** | `/po` | Product alignment | .github/audits/results/product-owner/ | [SKILL.md](../../skills/quality/po-audit/SKILL.md) |
| **security-audit** | `/security` | Security review | .github/audits/results/application-security/ | [SKILL.md](../../skills/quality/security-audit/SKILL.md) |
| **tech-debt-tracker** | `/tech-debt` | Tech debt inventory | .github/docs/tech-debt-inventory.md | [SKILL.md](../../skills/quality/tech-debt-tracker/SKILL.md) |
| **ux-audit** | `/ux` | UX review | .github/audits/results/ux-design/ | [SKILL.md](../../skills/quality/ux-audit/SKILL.md) |

## 📚 Documentation

| Skill | Command | When | Output | SKILL |
|-------|---------|--------|--------|-------|
| **adr-generator** | `/adr` | Architecture Decision Record | .github/docs/adr/ | [SKILL.md](../../skills/docs/adr-generator/SKILL.md) |
| **changelog-generator** | `/changelog` | Generate CHANGELOG | CHANGELOG.md | [SKILL.md](../../skills/docs/changelog-generator/SKILL.md) |
| **plantuml-generator** | `/diagram` | UML diagrams (/diagram) | .github/diagrams/ | [SKILL.md](../../skills/docs/plantuml-generator/SKILL.md) |
| **readme-updater** | `/readme` | Update README(s) | README in repo | [SKILL.md](../../skills/docs/readme-updater/SKILL.md) |
| **release-manager** | `—` | Release checklist | .github/plans/releases/ | [SKILL.md](../../skills/docs/release-manager/SKILL.md) |

## 🤖 Agents (long flows)

| Agent | Command | When | Output | File |
|-------|---------|--------|--------|-------|
| **migration** | `/migrate` | Adapt kit to legacy repo | .github/plans/migrations/ | [agent](../../agents/migration.agent.md) |
| **spec-review** | `/spec-review` | Spec gate before coding | .github/plans/reviews/ | [agent](../../agents/spec-review.agent.md) |
| **implementation-plan** | `/implement` | Phased plan | .github/plans/implementations/ | [agent](../../agents/implementation-plan.agent.md) |
| **implementation-executor** | `/execute` | Run phase + tests | Código no repo | [agent](../../agents/implementation-executor.agent.md) |
| **pr-reviewer** | `/pr-review` | Review open PR | .github/plans/reviews/pr-* | [agent](../../agents/pr-reviewer.agent.md) |
| **audit-runner** | `/audit-run` | Orchestrated audit | .github/audits/results/ | [agent](../../agents/audit-runner.agent.md) |
| **release** | `/release` | Changelog, tag, release | CHANGELOG.md + tag | [agent](../../agents/release.agent.md) |
| **mentoring** | `/mentor` | Socratic teaching | *(chat)* | [agent](../../agents/mentoring.agent.md) |

