# Organização do Hyperion

Por que a pasta está assim, o que é essencial, o que pode ignorar, e como adotar em **seu** repositório.

**Repo oficial:** [https://github.com/MatheusFelipeCorrea/Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion) · **English:** [organization-en.md](./organization-en.md) · **Structure map:** [STRUCTURE.md](../../STRUCTURE.md)

---

## Princípios de organização

1. **`.github/` = cérebro do kit** — skills, agents, cards, audits, docs de metodologia.
2. **`scripts/` = automação determinística** — sync, doctor, setup (agentes delegam aqui).
3. **Runtime rules fora de `.github/`** — `.cursor/rules/`, `CLAUDE.md`, `instructions/` (IDE-specific).
4. **Gerado ≠ versionado** — planos, reviews, migrações, audits: gitignored (`.gitignore`); pastas com `.gitkeep`.
5. **Referência ≠ board** — `_examples/` e templates nunca vão pro GitHub Project.

---

## O que copiar para seu projeto

| Copiar | Obrigatório? |
|--------|--------------|
| `.github/skills/`, `agents/`, `docs/`, `audits/`, `commands.yml`, `memory/`, `cards/` limpo, `project.example.yml`, … | Sim (merge se já existir) |
| `scripts/` | Sim |
| Scripts `hyperion:*` / `cards:*` (**merge** no seu `package.json`) | Recomendado |
| `bin/` + `Dockerfile` | Se host sem Node — [node-and-docker.md](./node-and-docker.md) |
| `.cursor/rules/` / `CLAUDE.md` | Conforme a IDE |
| `.env.example` | Recomendado |

**Não copie:** `.git/` deste repo · **`project.yml`** do Hyperion (use `project.example.yml`) · **`workflows/`** do kit (use **`/pipeline`**) · artefatos gerados.

---

## O que é desnecessário para o dia a dia

| Item | Pode ignorar? | Notas |
|------|---------------|-------|
| `audits/prompts/*.md` | Sim (agente lê) | Mantenedores de skills |
| `SKILL.template.md` | Sim | Só ao criar skill nova |
| `project.schema.json` | Quase | project-discovery valida |
| `exemplars.md` | Sim até ter padrões | Opcional por time |
| `STRUCTURE.md` | Mapa de pastas do kit | Consulta rara |
| Guia completo + pares EN | Escolha um idioma | Evite ler tudo |

---

## Redundâncias intencionais (não “lixo”)

| Camadas | Por quê |
|---------|---------|
| 3 runtime rules | Cursor / Claude / Copilot — sincronizadas via `.github/commands.yml` + `hyperion:generate-rules` |
| Prompt + skill por audit | Prompt = checklist; skill = orquestração + output path |
| PT + EN docs | Mesmo conteúdo, locales diferentes |
| `hyperion:*` + `cards:*` | Master vs granular (CI usa cards direto) |

Fonte anti-duplicação (mantenedores do repo Hyperion): [CONTRIBUTING.md](../../../CONTRIBUTING.md)

---

## Adotar em monorepo / repo existente

1. Copie o kit de [Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion) → **`/migrate`** (recomendado) ou merge manual de `.github/`.
2. Revise `project.yml` — especialmente `commands` e `management`.
3. `npm run hyperion:doctor` ou **`/doctor`**.
4. Guia: [adaptar-ao-repo.md](../onboarding/adaptar-ao-repo.md).

---

## Atualizar o kit em um repo cliente (`hyperion:upgrade`)

Parecido com `npm audit` / update: consulta o GitHub de origem (`.github/hyperion-origin.json`), compara com o pin local e aplica o delta.

```bash
# No repo CLIENTE
npm run hyperion:upgrade              # consulta origem + mostra plano
npm run hyperion:upgrade -- --check   # só diz se há update (exit 1 se atrasado)
npm run hyperion:upgrade -- --yes     # baixa (clone raso) + aplica

# Offline / path local (opcional)
npm run hyperion:upgrade -- --from /caminho/Hyperion-novo --yes
```

Origem padrão: repo/ref em `hyperion-origin.json` (override: `--repo`, `--ref`, ou env `HYPERION_ORIGIN_REPO`).

**Atualiza:** `scripts/hyperion` (inclusive os templates de workflow), `scripts/cards-sync`, skills, agents, audits, docs, rules, merge de scripts `hyperion:`/`cards:` no `package.json`.

**Preserva:** `.github/project.yml`, `memory/`, `cards/`, `plans/`, pastas de board, `.env`, **todos** os workflows (`.github/workflows/`). Os `hyperion-*.yml` do produto vêm do `/pipeline`; depois do upgrade, atualize-os a partir dos templates novos com `npm run hyperion:pipeline-apply -- --refresh-sync --yes` (sync e board guard) e `-- --refresh-gates --yes` (CI do produto).

Grava `.github/hyperion-kit.json` com `commit` + timestamp (pin para o próximo check).

---

## Árvore mental (3 pilares)

![Três pilares do Hyperion — Config, Trabalho, Automação](../assets/hyperion-three-pillars.png)

---

## Ver também

- [armadilhas-comuns.md](../troubleshooting/armadilhas-comuns.md) — gaps de aprendizado
- [comandos-rapidos.md](../reference/comandos-rapidos.md) — atalhos agente + npm
- [skills-output-map.md](../reference/skills-output-map.md) — onde cada skill grava arquivos
