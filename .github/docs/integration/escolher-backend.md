# Escolher backend de gestão (GitHub, Jira, etc.)

**English:** [choose-backend-en.md](../integration/choose-backend-en.md)

Use este guia para decidir **onde seus cards vão parar** e qual caminho de setup seguir.

---

## Árvore de decisão

```
Você usa qual ferramenta de gestão?
│
├── GitHub Projects (Issues + board no repo)
│   └── → [setup-github.md](../onboarding/setup-github.md) + /setup
│
├── Jira
│   └── → integration-bridge + env vars abaixo
│
├── Azure DevOps
│   └── → integration-bridge + env vars abaixo
│
├── Linear
│   └── → integration-bridge + env vars abaixo
│
└── GitLab Issues
    └── → integration-bridge + env vars abaixo
```

---

## Comparativo rápido

| Backend | Setup | Sync | Status no board | Reverse |
|---------|-------|------|-----------------|---------|
| **GitHub** | Mais fácil (`gh auth login`) | Completo | Coluna Status ✅ | ✅ |
| **Jira** | API token + env vars | Forward + reverse | Transição workflow ✅ | ✅ |
| **Azure DevOps** | PAT + env vars | Forward + reverse | `System.State` via `status_map` ✅ | ✅ |
| **Linear** | API token | Forward + reverse | `status_map` optional | ✅ |
| **GitLab** | Token + project ID | Forward + reverse | open/close + label `status:` ✅ | ✅ |

> **Recomendação:** se você já está no GitHub, use GitHub Projects — é o caminho com mais automação.

---

## GitHub Projects (default)

**Quando escolher:** repo no GitHub, board de projeto no mesmo ecossistema.

**Setup:**

1. [github-cli-setup.md](../integration/github-cli-setup.md) — `gh auth login`
2. **`/setup`** ou `npm run hyperion:setup -- --yes`
3. `npm run cards:watch` (opcional, sync ao salvar)

**Peça ao agente:** *"Configura cards sync"* → skill `cards-sync-setup`

---

## Jira

**Quando escolher:** time já usa Jira Cloud/Server como fonte de verdade.

**Setup:**

1. Copie [`.env.example`](../../../.env.example) → `.env`
2. Preencha: `JIRA_URL`, `JIRA_PROJECT_KEY`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
3. Defina `CARDS_SYNC_BACKEND=jira`
4. Em `project.yml`:

```yaml
management:
  backend: jira
  url: https://sua-org.atlassian.net
  project_key: PROJ
```

5. Sync: `CARDS_SYNC_BACKEND=jira npm run cards:sync`

**Peça ao agente:** *"Conecta ao Jira"* → skill `integration-bridge`

**Dica:** mapeie nomes de status PT em `projects-map.json` → `optionMapByLocale`.

---

## Azure DevOps

**Env:** `CARDS_SYNC_BACKEND=azure-devops`, `AZDO_ORG_URL`, `AZDO_PROJECT`, `AZDO_PAT` · opcional `AZDO_WORK_ITEM_TYPE=Task`

Forward + reverse via `CARD_ID`. Status remoto: `System.State` via `management.status_map` em `project.yml`.

---

## Linear

**Env:** `CARDS_SYNC_BACKEND=linear`, `LINEAR_TEAM_ID`, `LINEAR_API_TOKEN`

Opcional em `project.yml`: `management.status_map` para nomes de estado do time.

Forward + reverse, incluindo status via workflow states.

---

## GitLab

**Env:** `CARDS_SYNC_BACKEND=gitlab`, `GITLAB_PROJECT_ID`, `GITLAB_TOKEN` · opcional `GITLAB_URL` (default gitlab.com)

Forward + reverse via `CARD_ID`. Status: open/close + label `status:` via `status_map`.

---

## Depois de escolher

| Próximo passo | Documento |
|---------------|-----------|
| Criar cards | **`/refine`** — [catalogo-skills.md](../reference/catalogo-skills.md) |
| Evoluir cards | *"mova CARD-ID para Done"* — [card-refiner](../../skills/planning/card-refiner/SKILL.md) |
| Auditar repo | [primeira-auditoria.md](../quality/primeira-auditoria.md) |
