# Choose management backend (GitHub, Jira, etc.)

Use this guide to decide **where your cards land** and which setup path to follow.

**Português:** [escolher-backend.md](./escolher-backend.md)

---

## Decision tree

```
Which management tool do you use?
│
├── GitHub Projects
│   └── → [setup-github-en.md](../onboarding/setup-github-en.md) + /setup
│
├── Jira / Azure / Linear / GitLab
│   └── → integration-bridge + env vars below
```

---

## Quick comparison

| Backend | Setup | Sync | Board status | Reverse |
|---------|-------|------|-----------------|---------|
| **GitHub** | Easiest (`gh auth login`) | Full | Status column ✅ | ✅ |
| **Jira** | API token + env vars | Forward + reverse | Workflow transition ✅ | ✅ |
| **Azure DevOps** | PAT + env vars | Forward + reverse | `System.State` via `status_map` ✅ | ✅ |
| **Linear** | API token | Forward + reverse | optional `status_map` | ✅ |
| **GitLab** | Token + project ID | Forward + reverse | open/close + `status:` label ✅ | ✅ |

---

## GitHub Projects (default)

[setup-github-en.md](../onboarding/setup-github-en.md) · **`/setup`** · `cards-sync-setup` skill

---

## Jira

**Env:** `CARDS_SYNC_BACKEND=jira`, `JIRA_URL`, `JIRA_PROJECT_KEY`, `JIRA_EMAIL`, `JIRA_API_TOKEN`

```yaml
management:
  backend: jira
  url: https://your-org.atlassian.net
  project_key: PROJ
```

---

## Azure DevOps

**Env:** `CARDS_SYNC_BACKEND=azure-devops`, `AZDO_ORG_URL`, `AZDO_PROJECT`, `AZDO_PAT` · optional `AZDO_WORK_ITEM_TYPE=Task`

Forward + reverse via `CARD_ID`. Remote status: `System.State` via `management.status_map` in `project.yml`.

---

## Linear

**Env:** `CARDS_SYNC_BACKEND=linear`, `LINEAR_TEAM_ID`, `LINEAR_API_TOKEN`

Optional `management.status_map` in `project.yml`.

Forward + reverse, including workflow-state status.

---

## GitLab

**Env:** `CARDS_SYNC_BACKEND=gitlab`, `GITLAB_PROJECT_ID`, `GITLAB_TOKEN` · optional `GITLAB_URL`

Forward + reverse via `CARD_ID`. Status: open/close + `status:` label via `status_map`.

---

## After choosing

| Next | Document |
|------|----------|
| Create cards | **`/refine`** — [skills-catalog.md](../reference/skills-catalog.md) |
| Evolve cards | [card-refiner](../../skills/planning/card-refiner/SKILL.md) |
| Audit | [first-audit-en.md](../quality/first-audit-en.md) |
