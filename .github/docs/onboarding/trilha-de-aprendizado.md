# 📚 Trilha de aprendizado Hyperion

<p align="center">
  <img src="https://img.shields.io/badge/🟢-dia_1-22C55E?style=flat-square&labelColor=0B1220" alt="dia 1">
  <img src="https://img.shields.io/badge/🟡-github-EAB308?style=flat-square&labelColor=0B1220" alt="github">
  <img src="https://img.shields.io/badge/🔵-sdlc-2563EB?style=flat-square&labelColor=0B1220" alt="sdlc">
</p>

**Duas velocidades.** Não leia o kit inteiro — escolha seu nível e siga em ordem.

Antes de aprofundar, leia no hub: [o que é](../../../README.md#o-que-é-o-hyperion) · [áreas](../../../README.md#mapa-rápido--onde-usar) · [skills](../../../README.md#skills-por-área--o-que-fazem)

| Legenda | Significado |
|---------|-------------|
| 🟢 | Iniciante — chat + 6 comandos |
| 🟡 | Intermediário — GitHub, cards, repo |
| 🔵 | Avançado — SDLC completo, referência |

**English:** [learning-path-en.md](./learning-path-en.md) · **Repo:** [MatheusFelipeCorrea/Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion)

---

## 🎯 Escolha o seu ritmo

| Você | Faça | Ignore no 1º dia |
|------|------|------------------|
| 🟢 **Nunca usou agents** | Níveis 1–2 + catálogo filtrado | README técnico do cards-sync |
| 🟡 **Já usa agents/CI** | Níveis 1 + 3–4 | Glossário longo |
| 🔵 **Lead / mantenedor** | Níveis 1 + 5–6 | — |
| 📋 **PM / PO** | [trilha-pm.md](./trilha-pm.md) — refine + sync, sem CI | Pipeline, schema, backends |

**Kit mínimo:** `/setup` ou `/migrate` → `/doctor` → `/refine` → `/implement` → `/execute` → `/help`

![Jornada mínima](../assets/hyperion-journey-minimal.png)

---

## 🟢 Nível 1 — Primeiro contato · ⏱️ ~15 min

[GETTING-STARTED.md](../../../GETTING-STARTED.md) — glossário + 6 comandos.

**Faça agora:** clone [Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion) → copie o kit → **`/setup`** ou **`/migrate`** → **`/doctor`**.

---

## 🟡 Nível 2 — GitHub · ⏱️ ~15 min

| Doc | Quando |
|-----|--------|
| [setup-github.md](./setup-github.md) | Sync de cards no GitHub |
| [github-cli-setup.md](../integration/github-cli-setup.md) | Só se `gh` faltar |

**Faça agora:** **`/refine`** → **`/sync`**.

💡 Outros backends (Jira, Linear…): [escolher-backend.md](../integration/escolher-backend.md) — não é passo 2.

---

## 🟡 Nível 3 — Seu repo · ⏱️ ~15 min

[adaptar-ao-repo.md](./adaptar-ao-repo.md) — `project.yml`, `commands`, `memory`.

```bash
npm run hyperion:repo-detect   # opcional — sugere commands.test, lint, etc.
```

---

## 🔵 Nível 4 — SDLC · ⏱️ ~20 min

[fluxo-completo.md](../meta/fluxo-completo.md) — fluxo maduro (diagrama completo).

---

## 🔵 Nível 5 — Referência · consulta

| Doc | Para quê |
|-----|----------|
| [catalogo-skills.md](../reference/catalogo-skills.md) | 🧩 **Qual skill usar** (30 skills + agents) |
| [comandos-rapidos.md](../reference/comandos-rapidos.md) | 💬 Slash commands |
| [definition-of-done.md](../meta/definition-of-done.md) | ✅ Gates `*-verify` |
| [node-and-docker.md](../meta/node-and-docker.md) | 🐳 Node nativo ou Docker |
| [skills-output-map.md](../reference/skills-output-map.md) | 📁 Onde grava cada output |
| [cheatsheet-metodologia.md](../reference/cheatsheet-metodologia.md) | Agent vs skill vs script |

---

## 🔵 Nível 6 — Sob demanda

`integration/` · `quality/` · [cards-sync README](../../../scripts/cards-sync/README.md) · [CONTRIBUTING.md](../../../CONTRIBUTING.md)

---

➡️ [Índice da documentação](../README.md)
