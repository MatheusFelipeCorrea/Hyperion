# 💬 Comandos rápidos Hyperion

<p align="center">
  <img src="https://img.shields.io/badge/preferência-falar_no_chat-F5D76E?style=for-the-badge&labelColor=0B1220" alt="chat">
  <img src="https://img.shields.io/badge/npm-opcional-94A3B8?style=for-the-badge&labelColor=0B1220" alt="npm">
</p>

Referência única: **chat da IA** (dia a dia) e **npm** (CI / terminal).

| Nível | O que ler |
|-------|-----------|
| 🟢 | [Kit mínimo](#kit-mínimo-primeira-semana) — 6 comandos |
| 🟡 | [Fale com o agente](#preferência-fale-com-o-agente) — frases no chat |
| 🔵 | [npm one-liners](#npm--one-liners) — CI e power users |

Mapa de áreas + skills: [README.md](../../../README.md#mapa-rápido--onde-usar) · [catalogo-skills.md](./catalogo-skills.md)

**English:** [quick-commands-en.md](./quick-commands-en.md)

---

## 🟢 Kit mínimo (primeira semana)

Digite **no chat**, não no terminal. Slash no Claude Code; no Cursor o texto equivalente também vale.

| Ordem | Comando | Nível |
|-------|---------|-------|
| 1 | **`/setup`** (repo novo) ou **`/migrate`** (já tem código) | 🟢 |
| 2 | **`/doctor`** | 🟢 |
| 3 | **`/refine`** | 🟢 |
| 4 | **`/implement`** → **`/execute`** | 🟡 |
| 5 | **`/help`** | 🟢 |

`/discover` ≠ `/explore` ≠ `/migrate`: discover só mapeia `project.yml`; explore é hipótese de produto; migrate adapta kit a repo legado.

`/audit` (skill, 6 dimensões) vs **`/audit-run`** (mesmo conteúdo, agent com gates). Use `/audit` no dia a dia.

---

## Preferência: fale com o agente

Se você usa Cursor, Copilot ou Claude Code, **não precisa rodar npm**. Diga:

| Diga isto | O que acontece |
|-----------|----------------|
| **`/setup`** ou *"Configura o Hyperion neste repo"* | Setup completo guiado (`project-startup`) |
| **`/doctor`** ou *"Rode o doctor do Hyperion"* | Verifica saúde do kit + cards |
| **`/sync`** ou *"Sincroniza os cards"* | Valida e sobe cards pro GitHub |
| **`/discover`** ou *"Descobre esse projeto"* | Mapeia repo, cria/atualiza `project.yml` |
| **`/migrate`** ou *"Adapta Hyperion a este repo"* | Repo legado → project.yml + memory + pipeline |
| **`/refine`** ou *"Refina em cards"* | Gera cards estruturados |
| **`/audit`** ou *"Auditoria completa"* | 6 dimensões de auditoria |
| **`/review`** | Code review |
| **`/pr-review`** | Revisão de PR aberto (diff + testes) |
| **`/deps`** | Saúde de dependências (audit + outdated) |
| **`/implement`** | Plano de implementação de um card |
| **`/execute`** | Executa fase aprovada do plano (+ testes) |
| **`/spec-review`** | Gate de spec/card antes de codar |
| **`/audit-run`** | Auditoria orquestrada (6 dimensões) |
| **`/release`** | Changelog, versão e tag |
| **`/diagram`** ou *"Pacote completo de diagramas"* | 12 tipos (UML + pipeline CI/CD) em `.github/diagrams/` |
| **`/spec`** | Spec BDD + flowchart opcional por story |
| **`/help`** ou *"Lista comandos Hyperion"* | Mostra atalhos |

Slash commands funcionam nativamente no **Claude Code** (`CLAUDE.md`). No **Cursor**, `.cursor/rules/hyperion.mdc` mapeia os mesmos triggers.

---

## npm — one-liners

**Node 20+** na raiz **ou** `./bin/hyperion` (Docker) — [node-and-docker.md](../meta/node-and-docker.md).

```bash
npm run hyperion:help              # lista tudo
npm run hyperion:doctor            # saúde kit + cards
npm run hyperion:setup -- --yes    # bootstrap completo (cards)
npm run hyperion:sync              # validate + sync
npm run hyperion:sync -- --dry-run # simula sem escrever
npm run hyperion:phase-verify -- --plan <path>
npm run hyperion:project-verify
npm run hyperion:review-verify -- --review <path>
npm run hyperion:cli -- doctor     # CLI unificada
npm run hyperion:upgrade                          # GitHub origin: check + plano
npm run hyperion:upgrade -- --yes                 # baixa origem + aplica
npm run hyperion:upgrade -- --check               # exit 1 se atrasado
npm run hyperion:upgrade -- --from <kit> --yes    # offline / path local
./bin/hyperion doctor                             # Node nativo ou Docker
npm run hyperion:docker-build                     # imagem hyperion-cli
```

Gates: [definition-of-done.md](../meta/definition-of-done.md). Sem Node: [node-and-docker.md](../meta/node-and-docker.md).

### Primeira vez (GitHub)

```bash
gh auth login
npm run hyperion:setup -- --yes
# ou peça ao agente: /setup
```

### Dia a dia

```bash
npm run hyperion:sync              # após editar cards
npm run cards:watch                # sync ao salvar (opcional)
```

---

## Auditorias (só agente)

Auditorias são **read-only** — o agente lê o repo e grava relatórios em `.github/audits/results/`.

| Frase | Skill |
|-------|-------|
| *"Auditoria completa"* | `full-audit` |
| *"Revisão de segurança"* | `security-audit` |
| *"Revisa a arquitetura"* | `architecture-audit` |
| *"Revisão de DevOps"* | `devops-audit` |
| *"Code review"* | `code-review` |
| *"Alinhamento de produto"* | `po-audit` |
| *"Revisão de UX"* | `ux-audit` |

Guia: [primeira-auditoria.md](../quality/primeira-auditoria.md)

---

## Diagramas (`/diagram`)

Skill `plantuml-generator` — gera **fontes** `.puml` / `.mmd` (PNG é export manual).

| Diga isto | Resultado |
|-----------|-----------|
| **`/diagram`** + *"Pacote completo"* | 12 diagramas na ordem recomendada (aprovação entre cada um) |
| *"Diagrama de sequência do login"* | `Sequencia/sequencia-login.puml` |
| *"Modelo ER do banco"* | `Modelo de Dados/modelo-dados.puml` |
| *"Estados do pedido"* | `Estado/estado-pedido.puml` |

Tipos: caso de uso, componentes, pacotes, classes, ER, implantação, fluxo de dados, sequência, atividade, estado, prompt C4.

Mapa completo: [diagrams/README.md](../../diagrams/README.md) · [onde-ficam-os-outputs.md](../meta/onde-ficam-os-outputs.md)

---

## O que mantém os comandos atualizados?

| Fonte | Papel |
|-------|-------|
| **`.github/commands.yml`** | Registro canônico de frases, skills e npm |
| `npm run hyperion:generate-rules` | Regenera `help.mjs`, `CLAUDE.md`, `hyperion.mdc`, `copilot-instructions.md` |
| `npm run hyperion:check-rules` | CI — falha se runtime rules estiverem desatualizadas |
| `package.json` | Scripts npm (`hyperion:*`, `cards:*`) |
| `scripts/hyperion/help.mjs` | Texto do `hyperion:help` (gerado) |
| `.github/skills/setup/project-startup/` | Orquestrador setup completo |
| `.github/skills/setup/hyperion-ops/` | Agente roda npm por você |
| `.github/audits/manifest.yml` | Tipos de auditoria |

**Só se você contribui no repositório Hyperion:** edite `commands.yml` → `npm run hyperion:generate-rules` → commit. Ver [CONTRIBUTING.md](../../../CONTRIBUTING.md).

Guia de confusões frequentes: [armadilhas-comuns.md](../troubleshooting/armadilhas-comuns.md)

---

## Ver também

- [setup-github.md](../onboarding/setup-github.md)
- [scripts/cards-sync/README.md](../../../scripts/cards-sync/README.md)
- Skills: `.github/skills/setup/project-startup/SKILL.md`, `hyperion-ops/SKILL.md`
