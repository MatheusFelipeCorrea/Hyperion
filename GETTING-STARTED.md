# 🚀 Getting Started — Hyperion

<p align="center">
  <img src="./.github/docs/assets/hyperion-logo.png" alt="Hyperion" width="180">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/🟢-iniciante-22C55E?style=flat-square&labelColor=0B1220" alt="iniciante">
  <img src="https://img.shields.io/badge/chat-não_terminal-F5D76E?style=flat-square&labelColor=0B1220" alt="chat">
  <img src="https://img.shields.io/badge/6_comandos-primeira_semana-2563EB?style=flat-square&labelColor=0B1220" alt="6">
</p>

Do zero (ou repo legado) ao primeiro release. **Não precisa saber o que é um “agent”.** No primeiro dia, pare nos **6 comandos** — o resto é para depois.

### O que o Hyperion faz (em uma frase)

Você copia o kit para o **seu** repo → fala com a IA no chat (`/setup`, `/refine`, `/execute`…) → ela segue receitas prontas e grava cards, planos e audits em pastas padrão. Opcionalmente **`/sync`** sobe o board.

| Área | Exemplos no chat |
|------|------------------|
| 🧭 Ligar o kit | `/setup` · `/migrate` · `/doctor` |
| 📋 Planejar | `/refine` · `/spec` · `/explore` |
| ⚡ Entregar | `/implement` · `/execute` · `/pr-review` |
| 🔍 Qualidade | `/audit` · `/deps` |
| 📚 Docs / release | `/diagram` · `/release` |

Visão geral + catálogo: [README.md](./README.md) · [catalogo-skills.md](./.github/docs/reference/catalogo-skills.md)

| Nível | Você | Comece aqui |
|-------|------|-------------|
| 🟢 **Iniciante** | Primeira vez com IA no repo | [Dois caminhos](#dois-caminhos-não-leia-os-30-skills) → 6 comandos |
| 🟡 **Intermediário** | Já usa Cursor/Copilot | Passos 1–4 + [setup-github](./.github/docs/onboarding/setup-github.md) |
| 🔵 **Avançado** | Multi-app, CI, vários boards | [catálogo](./.github/docs/reference/catalogo-skills.md) · [comandos](./.github/docs/reference/comandos-rapidos.md) · [fluxo](./.github/docs/meta/fluxo-completo.md) |

**English:** [learning-path-en.md](./.github/docs/onboarding/learning-path-en.md) · **Trilha:** [trilha-de-aprendizado.md](./.github/docs/onboarding/trilha-de-aprendizado.md) · **Fluxo:** [fluxo-completo.md](./.github/docs/meta/fluxo-completo.md)

---

## 📖 Palavras que aparecem no kit

| Termo | Significado na prática |
|-------|------------------------|
| **Assistente / agente** | O chat de IA (Cursor, Copilot, Claude Code). Você conversa; ele lê o kit. |
| **Comando** (`/setup`) | Você **digita no chat**, não no terminal. É um atalho para uma receita. |
| **Skill** | Uma receita curta (`SKILL.md`) que a IA segue uma vez. |
| **Agent** (arquivo `.agent.md`) | Receita **longa**, com pausas para você aprovar. |
| **npm** (`hyperion:*`) | Opcional. CI e quem prefere terminal. |

Se o slash não aparecer no Cursor, escreva a frase: *“Configura o Hyperion neste repo”*.

---

## 🎯 Dois caminhos (não leia os 30 skills)

### 🟢 Nunca usei agents / primeira vez no Hyperion

Memorize **6 comandos**. O resto existe; ignore até precisar.

| Ordem | No chat | O que acontece |
|-------|---------|----------------|
| 1 | **`/setup`** ou **`/migrate`** | Liga o kit ao repo (`project.yml`) |
| 2 | **`/doctor`** | Diz o que falta (gh, token, cards) |
| 3 | **`/refine`** | Sua ideia vira cards |
| 4 | **`/implement`** | Plano em fases (você aprova) |
| 5 | **`/execute`** | Código + testes do **seu** repo |
| 6 | **`/help`** | Lista o restante quando quiser |

Repo **já tem código** → `/migrate`. Repo **novo** → `/setup`.

![Jornada mínima — 6 passos](./.github/docs/assets/hyperion-journey-minimal.png)

### 🔵 Já uso agents no dia a dia

- [catalogo-skills.md](./.github/docs/reference/catalogo-skills.md) · [comandos-rapidos.md](./.github/docs/reference/comandos-rapidos.md) · [fluxo-completo.md](./.github/docs/meta/fluxo-completo.md)

---

## 📦 1 — Copiar o kit

**Repositório oficial:** [https://github.com/MatheusFelipeCorrea/Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion)

```bash
git clone https://github.com/MatheusFelipeCorrea/Hyperion.git
```

### Preferido — pasta `Hyperion/` no produto (sem poluir a raiz)

1. Clone/ZIP → pasta chamada **`Hyperion`**.
2. Coloque-a em `seu-produto/Hyperion/` (kit inteiro: `.github`, `scripts`, `Dockerfile`, …).
3. Na **raiz do produto**:

```bash
npm run hyperion:init --prefix Hyperion -- --adopt
```

Isso grava shims (`CLAUDE.md`, `.cursor/rules/hyperion.mdc`, `.github/project.yml` com `kit.root: Hyperion`) e **não** espalha skills na raiz.

4. Abra o chat no **produto** → **`/setup`** ou **`/migrate`**.

Cards e plans ficam sob `Hyperion/.github/…`. Já tem CI própria? Use `ci.policy: skip` (ou ignore `/pipeline`) — Hyperion não exige a pipeline do kit.

### Legado — copiar seletivo na raiz (ainda funciona)

Copie para a **raiz do seu repositório** (não o `.git` do Hyperion):

| Copiar | Não copiar / cuidado |
|--------|----------------------|
| `.github/skills/`, `agents/`, `docs/`, `audits/`, `commands.yml`, `memory/` (templates), `cards/` (template + config limpo), `diagrams/`, `project.example.yml`, `project.schema.json`, `hyperion-origin.json` | **`.github/project.yml`** do Hyperion → use `project.example.yml` ou `/setup` |
| `scripts/` | **`.github/workflows/`** → **`/pipeline`** no seu repo (ou `ci.policy: skip`) |
| Scripts `hyperion:*` / `cards:*` no **seu** `package.json` (**merge**) | Substituir o `package.json` do produto |
| `bin/` + `Dockerfile` (sem Node) | `projects-map` de outro time |
| `.env.example`, `CLAUDE.md`, `.cursor/rules/` conforme a IDE | Artefatos gerados (`plans/`, audit results) |

Atualizar um repo que já tem o kit: `npm run hyperion:upgrade` (na pasta do kit / com `kit.root`).

Sem Node: [node-and-docker.md](./.github/docs/meta/node-and-docker.md). Gates: [definition-of-done.md](./.github/docs/meta/definition-of-done.md).

---

## ⚙️ 2 — Configurar (adaptável ao repo)

### Repo legado (já tem código)

> **`/migrate`** — ou *"Adapta o Hyperion a este repo"*

O agente detecta stack, CI, testes e escreve `project.yml` com bloco `commands:` adaptado.

### Repo novo ou setup completo

> **`/setup`** — ou *"Configura o Hyperion neste repo"*

### Detectar comandos do repo (avançado / terminal)

```bash
npm run hyperion:repo-detect
npm run hyperion:repo-detect -- --json
```

Isso sugere `commands.test`, `commands.lint`, etc. para colar em `project.yml`.

### GitHub CLI (só se for sync de cards no GitHub)

```bash
gh auth login
npm run hyperion:setup -- --yes
```

Sem GitHub Projects, pule isto. Jira/Linear/Azure/GitLab: [escolher-backend.md](./.github/docs/integration/escolher-backend.md) — não é passo 1.

---

## 📝 3 — Primeiro card

> **`/refine`** → **`/sync`**

Cards em `.github/cards/` — GitHub completo; Jira/Azure/GitLab/Linear com `--reverse`.

---

## 🚢 4 — Entrega (plano → código → testes → PR)

| Passo | Comando |
|-------|---------|
| Gate de spec (opcional na 1ª vez) | **`/spec-review`** |
| Plano em fases | **`/implement`** |
| Executar fase (+ testes do repo) | **`/execute`** |
| Revisar PR | **`/pr-review`** |

Testes usam `commands.test` do **seu** `project.yml` — não hardcoded.

---

## 🔍 5 — Qualidade e release (quando o time pedir)

| Passo | Comando |
|-------|---------|
| Auditoria orquestrada | **`/audit-run`** |
| Auditoria rápida (skill, sem o agent) | **`/audit`** |
| Saúde de dependências | **`/deps`** |
| Release | **`/release`** |

`/audit` e `/audit-run` fazem as **mesmas 6 dimensões**. Use `/audit` no dia a dia; `/audit-run` quando quiser o fluxo longo com gates.

---

## 🗺️ Jornada completa (não é o 1º dia)

```text
/migrate ou /setup → /refine → /spec → /spec-review → /implement → /execute
  → /pr-review → /audit-run → /deps → /release
```

![Jornada Hyperion](./.github/docs/assets/hyperion-journey-full.png)

---

## 🎛️ Agent vs npm vs CI

| Situação | Use |
|----------|-----|
| Primeira semana | **`/setup`** ou **`/migrate`**, **`/refine`**, **`/execute`** |
| Dia a dia com IA | **`/sync`**, **`/pr-review`**, **`/help`** |
| Debug / power users | **npm** — `hyperion:*`, `cards:*` |
| Validação do kit | **CI** — `hyperion-validate.yml` |

---

## ⚠️ Problemas?

| Sintoma | Solução |
|---------|---------|
| Repo legado confuso | **`/migrate`** |
| Testes falham no executor | Edite `commands.test` em `project.yml` |
| Regras Cursor | `npm run hyperion:cursor` |
| Não sei o que escrever no chat | **`/help`** ou [armadilhas-comuns.md](./.github/docs/troubleshooting/armadilhas-comuns.md) |

---

## ➡️ Próximos passos

| Quer aprender | Leia |
|---------------|------|
| Trilha | [trilha-de-aprendizado.md](./.github/docs/onboarding/trilha-de-aprendizado.md) |
| **Qual skill usar** | [catalogo-skills.md](./.github/docs/reference/catalogo-skills.md) |
| Setup GitHub | [setup-github.md](./.github/docs/onboarding/setup-github.md) |
| Adaptar repo | [adaptar-ao-repo.md](./.github/docs/onboarding/adaptar-ao-repo.md) |
| Índice | [docs/README.md](./.github/docs/README.md) |
