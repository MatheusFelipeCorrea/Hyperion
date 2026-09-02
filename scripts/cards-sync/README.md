# Cards Sync — Markdown cards → GitHub / Jira / Azure / Linear / GitLab

Syncs card files from `.github/cards/` to project management backends:

| Backend | Mode | Board/status behavior |
|---------|------|------------------------|
| **GitHub** (default) | forward + reverse | Updates Issues + Project fields; **status safe mode** applies |
| **Jira** | forward + reverse | Creates/updates issues; **applies workflow transitions** when status names match |
| **Azure DevOps** | forward + reverse | Creates/updates work items; **System.State** via `status_map` |
| **Linear** | forward + reverse | Creates/updates issues; **workflow state** via `status_map` |
| **GitLab** | forward + reverse | Creates/updates issues; open/close + `status:` label via `status_map` |

## How it works

1. You write cards as individual `.md` files with YAML frontmatter in `.github/cards/`
2. Forward sync reads them and creates/updates remote items (Issues, work items, etc.)
3. **GitHub**: populates Project fields, labels, and sub-issue links from `parent` + `## Sub-issues`
4. **Jira**: encodes card metadata in issue description; `--reverse` rebuilds Markdown from Jira
5. **Azure / Linear / GitLab**: create/update with `CARD_ID` idempotency; all support `--reverse` with non-destructive frontmatter patch

See [Backend support (current reality)](#backend-support-current-reality) for the full matrix.

**Related docs:** [Quick commands](../../.github/docs/reference/comandos-rapidos.md) · [Documentation index](../../.github/docs/README.md) · [GitHub CLI setup](../../.github/docs/integration/github-cli-setup.md) · [Choose backend](../../.github/docs/integration/escolher-backend.md) · [Cards sync hardening](../../.github/docs/integration/cards-sync-hardening.md) · [setup-github](../../.github/docs/onboarding/setup-github.md) · [card-refiner](../../.github/skills/planning/card-refiner/SKILL.md)

## Hyperion shortcuts (preferred)

| Agent | npm |
|-------|-----|
| **`/setup`** — full bootstrap | `npm run hyperion:setup -- --yes` |
| **`/sync`** — validate + push | `npm run hyperion:sync` |
| **`/doctor`** — health check | `npm run hyperion:doctor` |

Granular `cards:*` scripts remain for CI and power users. Command registry: `.github/commands.yml` → `npm run hyperion:help` (generated).

## Card file format

Each card is ONE file with YAML frontmatter:

```yaml
---
card_id: PROJ-EPIC-001
title: "Feature Name"
status: Backlog
type: Epic
priority: Highest
sprint: null
story_points: null
reporter: null
parent: null
due_date: null
categories:
  - Frontend
  - Backend
---

# [EPIC] Feature Name

Card body content here...

See **`.github/cards/CARD.template.md`** for the full friendly layout (emojis, code blocks, acceptance criteria).
```

### Card body style

| Where | Format |
|-------|--------|
| Local `.md` files | Human-friendly: `## 📋 Resumo`, backticks for APIs, `(EXISTENTE \| NOVO)` markers |
| YAML frontmatter | Canonical English values only — **no emojis** |
| GitHub Issue (after sync) | Auto-enriched: parent/sub-issue **links**, section polish, **🔄 Hyperion sync** footer |

When you create a card with `card-refiner` and run sync, the issue body is formatted for readers on GitHub without hand-maintaining links.

### Kit reference vs project cards (never synced by default)

| Path / pattern | Purpose | Forward / reverse sync |
|----------------|---------|------------------------|
| `CARD.template.md`, `*.template.md` | Blank template to copy | **Never** |
| `.github/cards/_examples/**` | Sample cards for agents/docs | **Never** |
| `card_id` `EXAMPLE-*`, `TEMPLATE-*`, `SAMPLE-*` | Misplaced kit samples (safety net) | **Never** |
| Remote issues with those CARD_IDs (or sample SOURCE_FILE) | Leftover kit samples on the board | **Never** (not mapped; skipped on `--reverse`) |
| `.github/cards/{epics,features,stories,tasks}/PROJ-*` | Your real work | **Yes** |

Agents read `_examples/` and `CARD.template.md` for guidance. Only cards **you create** under `epics/`, `features/`, `stories/`, `tasks/` go to GitHub — and only those come back on reverse sync. GitHub searches use `is:issue` (pull requests are out of scope).

Maintainers testing the kit itself: `--include-samples` (optional, not for normal adopters).

## File locations

- Epics: `.github/cards/epics/{CARD_ID}.md` (flat)
- Features: `.github/cards/features/{PARENT_EPIC_ID}/{CARD_ID}.md`
- Stories: `.github/cards/stories/{PARENT_ID}/{CARD_ID}.md`
- Tasks/Subtasks: `.github/cards/tasks/{PARENT_ID}/{CARD_ID}.md`
- Orphan (non-epic, no parent): `.github/cards/{type}/_orphan/{CARD_ID}.md`
- Config: `.github/cards/config/projects-map.json`

**Layout rule:** folder name under `features|stories|tasks` = the **`parent` card_id**. Changing `parent` means **moving** the file. Recursive discovery already syncs nested paths.

Migrate legacy flat files: `npm run cards:migrate-layout` (add `--dry-run` to preview). Validate warns on flat leftovers; `cards:validate --strict-layout` fails them.

## Field mapping

| Frontmatter | Project Field | Type |
|-------------|--------------|------|
| type | Type / Tipo | single select |
| priority | Priority / Prioridade | single select |
| sprint | Sprint / Numero da Sprint | iteration |
| story_points | Story Points | number |
| reporter | Reporter / Relator | text |
| parent | Parent (Epic/Feature) / Pai (Epic/Feature) | text |
| due_date | Due Date / Data Limite | date |
| categories | Labels (on Issue) | — |
| status | Status | single select |

## Setup

### 1. Configure your backend

For GitHub backend, create a GitHub Project on the repository with these fields:
- Status (single select): Backlog, Functional Refinement, Technical Refinement, In Progress, In Tests, In Revision, Done
- Type (single select): Epic, Feature, Story, Task, Subtask, Bug
- Priority (single select): Highest, High, Medium, Low
- Sprint (iteration)
- Story Points (number)
- Reporter (text)
- Parent (Epic/Feature) (text)
- Due Date (date)

Field-name detection is bilingual by default (EN/PT-BR aliases), so mixed boards
like `Type`/`Prioridade` still work. If your board uses custom names, keep using `fieldMap`.

Status update behavior (**GitHub Projects only — safe mode**):
- If `card.status` is provided in frontmatter: sync applies it to the Project Status column.
- If `card.status` is missing:
  - new issues/items: sync uses `defaults.status` (usually `Backlog`)
  - existing issues/items: sync preserves current Project status (no overwrite)

> **Other backends:** On forward sync, Jira applies workflow **transitions** when status names match; Azure updates **`System.State`** via `status_map`; GitLab open/close + `status:` label; Linear applies workflow state via `status_map`. Reverse (`--reverse`) works for all backends (non-destructive frontmatter patch). GitHub Projects still has the richest native-column + safe-mode behavior.

Worst-case behavior (Project auto-create):
- If the Project does not exist and `projects-map.json.default.projectNumber` is `0/null` (and `autoCreateProject` is enabled),
  the sync will auto-create a Project named: `[RepoName] Hyperion Project`
  (where `RepoName` is the repository name detected from git).
- The new Project is **linked to the repository** (`repositoryId` on create + `linkProjectV2ToRepository` on existing projects) so **Default repository** is set in Project Settings.

### 2. Edit projects-map.json

```json
{
  "default": {
    "projectOwner": "YOUR_USERNAME",
    "projectNumber": 7,
    "locale": "en",
    "fieldMap": { ... },
    "optionMapByLocale": { ... },
    "defaults": { "status": "Backlog" }
  }
}
```

- `projectOwner`: your GitHub username or org name
- `projectNumber`: the number from the Project URL (`/projects/7`)
- `locale`: output/config locale used by labels and option mappings

### 2.1 Option mapping (status/type/priority localization)

If your Project single-select options are localized (e.g. PT-BR), map canonical
card values to your board values:

```json
{
  "default": {
    "locale": "pt-BR",
    "optionMapByLocale": {
      "pt-BR": {
        "status": {
          "Backlog": "Backlog",
          "Functional Refinement": "Refinamento Funcional",
          "Technical Refinement": "Refinamento Técnico",
          "In Progress": "Em Progresso",
          "In Tests": "Em Testes",
          "In Revision": "Em Revisão",
          "Done": "Concluído"
        },
        "type": {
          "Epic": "Épico",
          "Feature": "Funcionalidade",
          "Story": "História",
          "Task": "Tarefa",
          "Subtask": "Subtarefa",
          "Bug": "Bug"
        },
        "priority": {
          "Highest": "Crítica",
          "High": "Alta",
          "Medium": "Média",
          "Low": "Baixa"
        }
      }
    }
  }
}
```

The sync also has built-in alias matching (PT/EN + accent-insensitive) for
common status/type/priority names.

### 3. Auth and backend variables

For GitHub backend, repository-level Projects usually work with `GITHUB_TOKEN`.

If it fails, create a fine-grained PAT with:
- Issues: Read and write
- Contents: Read
- Projects: Read and write

Save it as secret `PROJECT_SYNC_TOKEN` in repo Settings > Secrets.

For Jira backend, provide:
- `JIRA_URL` (example: `https://your-org.atlassian.net`)
- `JIRA_PROJECT_KEY` (example: `PROJ`)
- `JIRA_EMAIL` (Atlassian account email)
- `JIRA_API_TOKEN` (Atlassian API token)
- optional `JIRA_ISSUE_TYPE` (default: `Task`)

For Azure DevOps backend, provide:
- `AZDO_ORG_URL` (example: `https://dev.azure.com/your-org`)
- `AZDO_PROJECT` (example: `MyProject`)
- `AZDO_PAT` (Azure DevOps PAT)
- optional `AZDO_WORK_ITEM_TYPE` (default: `Task`)

For Linear backend, provide:
- `LINEAR_TEAM_ID` (team identifier)
- `LINEAR_API_TOKEN` (Linear API token)

For GitLab backend, provide:
- `GITLAB_URL` (optional; default: `https://gitlab.com`)
- `GITLAB_PROJECT_ID` (numeric project id, or encoded path depending on API)
- `GITLAB_TOKEN` (GitLab private token)
- optional `GITLAB_ISSUE_TYPE` (reserved for future use)

### 4. Labels

Labels come from `.github/cards/config/labels.{locale}.json` (for example
`labels.en.json` or `labels.pt-BR.json`) based on the configured locale.

**Catalog format (v2):** each entry is an object with `name`, `color` (6-char hex, no `#`), and `description`. Legacy v1 string arrays still work — colors fall back to a deterministic hash.

Set `CREATE_MISSING_LABELS=true` (default) to auto-create missing labels used in card `categories`. Forward sync applies catalog **color + description** on create and updates existing labels when metadata drifts.

**Reset labels (recommended on first setup):** GitHub repos ship default labels (`bug`, `enhancement`, …) and sync may accumulate orphans. Use the Hyperion catalog for your locale only:

```bash
npm run cards:labels-reset -- --dry-run   # preview
npm run cards:labels-reset -- --yes       # apply
```

This removes GitHub defaults + orphan labels, keeps Dependabot labels (`dependencies`, `github_actions`) by default, and ensures labels from `labels.{locale}.json` (including color and description). Card `categories` should use names from that same file.

`cards:init -- --yes` runs label reset automatically before sync.

**Project views:** on create/sync, Hyperion configures tabs in order: **Board** → **Tabela** → **Roadmap** (user can customize filters/grouping in the UI afterward).

**Sprint field:** auto-created as GitHub **Iteration** (`Sprint` / `Número da Sprint`). Cards may keep `sprint: null`; define sprint dates in Project Settings. Configure defaults in `projects-map.json` → `sprintField` (`durationDays`, optional `seedIterations`).

**Issue body enrichment (GitHub forward sync):** after create/update, sync rewrites the issue body with:
- Clickable **Parent** and **Sub-issues** links (`[CARD_ID (#n)](url)`)
- Optional section emoji headers (`## Resumo` → `## 📋 Resumo`) if not already present
- **🔄 Hyperion sync** blockquote (card id, parent, source path) + machine-readable `CARD_ID` metadata

**Unit tests:** `npm run cards:test` (27+ tests for parsers, mapping, body enrichment).

## Commands

```bash
# One-shot GitHub bootstrap (discover project → doctor → validate → dry-run → sync)
npm run cards:init
npm run cards:init -- --yes              # include real sync
npm run cards:init -- --install-hook     # + pre-commit validate hook

# Diagnose config + (when token exists) GitHub Project fields
node scripts/cards-sync/doctor.mjs --interactive

# Dry-run (no GitHub changes, just validate)
node scripts/cards-sync/sync.mjs --dry-run

# Forward sync (Markdown -> GitHub)
node scripts/cards-sync/sync.mjs

# Incremental sync (your cards — not kit samples in `_examples/`)
node scripts/cards-sync/sync.mjs --only PROJ-STORY-001,PROJ-EPIC-001
# or: CARDS_SYNC_ONLY=PROJ-STORY-001 node scripts/cards-sync/sync.mjs
# Kit samples (EXAMPLE-* / `_examples/`): never sync unless --include-samples (maintainers only)

# Forward sync using Jira backend
CARDS_SYNC_BACKEND=jira node scripts/cards-sync/sync.mjs

# Forward sync using Azure DevOps backend
CARDS_SYNC_BACKEND=azure-devops node scripts/cards-sync/sync.mjs

# Forward sync using Linear backend
CARDS_SYNC_BACKEND=linear node scripts/cards-sync/sync.mjs

# Forward sync using GitLab backend
CARDS_SYNC_BACKEND=gitlab node scripts/cards-sync/sync.mjs

# Reverse sync (GitHub -> Markdown)
node scripts/cards-sync/sync.mjs --reverse

# Reverse sync for Jira (Jira -> Markdown)
CARDS_SYNC_BACKEND=jira node scripts/cards-sync/sync.mjs --reverse

# Reverse dry-run
node scripts/cards-sync/sync.mjs --reverse --dry-run

# PR board guard (CI / local — reverse + diff, blocks merge on drift)
npm run cards:pr-guard

# Main CI sync (pull → verify → push — runs on merge to main)
npm run cards:ci-sync

# Unit tests (mapping/parser/hierarchy)
node --test scripts/cards-sync/*.test.mjs

# Watch mode — incremental validate + sync on file changes
node scripts/cards-sync/watch.mjs
# or: npm run cards:watch
```

## GitHub automation

**Prerequisite (local):** [GitHub CLI — install and login](../../.github/docs/integration/github-cli-setup.md) (`gh auth login`). The sync reads `gh auth token` automatically.

| Feature | How |
|---------|-----|
| Auto-detect repo | `git remote get-url origin` |
| Auto-detect token | `gh auth token` |
| Auto-discover Project | Lists repo Projects; picks `[RepoName] Hyperion Project`, any Hyperion title, or sole project; saves `projectNumber` |
| Auto-create Project | When none exists and `autoCreateProject: true` — links repo as default |
| Issue body links | Parent, sub-issues, Hyperion footer on forward sync |
| Incremental sync | `--only CARD_ID,...` or `CARDS_SYNC_ONLY` env (watch uses this); loads all issues for link resolution |
| Sync summary | Writes `.github/plans/cards/last-sync.md` after each forward sync |
| Pre-commit hook | `npm run cards:hook` validates staged `.github/cards/*.md` |
| **PR board guard** | `hyperion-cards-pr-check.yml` — directional reverse + diff; blocks **external** board drift only |
| **Main CI sync** | `hyperion-sync-cards.yml` — pull → verify → push after merge to main |

**Branch workflow:** create/edit cards on a feature branch (forward sync is skipped locally by `watch` and does not run until main). Open a PR → PR guard ensures board and branch agree → merge → main CI pushes to the Project.

Mark **Hyperion — Cards PR Board Guard** as a required status check in GitHub Branch protection.

Disable auto-discovery: set `"autoDiscoverProject": false` in `projects-map.json`.

## IDE → Board status update

When you edit a local card and change `status` in frontmatter:
- run `node scripts/cards-sync/sync.mjs` to apply it immediately (**GitHub: updates Project column**)
- or commit + push, and `.github/workflows/hyperion-sync-cards.yml` will sync automatically

On GitHub, explicit `status` in frontmatter always applies. Safe mode only applies when `status` is **omitted** on existing cards (preserves manual board moves).

**Conversational moves (agent):** ask *"mova EXAMPLE-STORY-001 para Done"* — agent edits frontmatter in place, validates, and runs sync. See `card-refiner` skill § Card evolution during conversation.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| GITHUB_REPOSITORY | Yes (auto in Actions) | owner/repo |
| GITHUB_TOKEN | Yes (auto in Actions) | Default token |
| PROJECT_SYNC_TOKEN | Optional | PAT override for Projects |
| PROJECT_OWNER | Optional | Override project owner |
| PROJECT_NUMBER | Optional | Override project number |
| DRY_RUN | Optional | "true" to simulate |
| SYNC_DIRECTION | Optional | "forward" or "reverse" |
| CREATE_MISSING_LABELS | Optional | "true" (default) to auto-create labels |
| CARDS_SYNC_BACKEND | Optional | `github` (default), `jira`, `azure-devops`, `linear`, `gitlab` |
| JIRA_URL | Required for Jira | Jira base URL |
| JIRA_PROJECT_KEY | Required for Jira | Jira project key |
| JIRA_EMAIL | Required for Jira | Jira account email |
| JIRA_API_TOKEN | Required for Jira | Jira API token |
| JIRA_ISSUE_TYPE | Optional for Jira | Issue type name (default `Task`) |
| AZDO_ORG_URL | Required for Azure | Azure DevOps org URL |
| AZDO_PROJECT | Required for Azure | Azure DevOps project name |
| AZDO_PAT | Required for Azure | Azure DevOps PAT |
| AZDO_WORK_ITEM_TYPE | Optional for Azure | Work item type (default `Task`) |
| LINEAR_TEAM_ID | Required for Linear | Linear team id/uuid |
| LINEAR_API_TOKEN | Required for Linear | Linear API token |
| GITLAB_PROJECT_ID | Required for GitLab | GitLab project id/path |
| GITLAB_TOKEN | Required for GitLab | GitLab private token |
| GITLAB_URL | Optional for GitLab | GitLab base URL |

## Hierarchy (sub-issues)

Parent-child links are created from:
1. `parent` field in frontmatter (CARD_ID of the parent)
2. `## Sub-issues` section in card body (list of child CARD_IDs)

Both methods work together and are deduplicated.

## Backend support (current reality)

Current implementation status:
- **GitHub**: full (Issues + Projects + fields + labels + sub-issues)
- **Jira**: forward + reverse + **workflow transitions** on forward sync when `status` is set
- **Azure DevOps**: forward + reverse + **System.State** via `management.status_map`
- **Linear**: forward + reverse + **workflow state** via `status_map`
- **GitLab**: forward + reverse + open/close + `status:` label via `status_map`

Reverse sync (`--reverse`) is implemented for **GitHub, Jira, Azure DevOps, GitLab, and Linear** (frontmatter patch only — card body preserved).

Doctor remote checks cover **GitHub, Jira, Azure, GitLab, and Linear**.

If you want to integrate another backend, the intended path is:
- configure connection + field mapping via the `integration-bridge` skill
- then implement a new adapter in `sync.mjs` (roadmap)

### Labels i18n

`projects-map.json` can define labels in two ways:
- **legacy**: `projects-map.json.default.labels` (array of label names)
- **i18n**: `projects-map.json.default.locale` + `projects-map.json.default.labelsFile`
  (loads a JSON array from `.github/cards/config/labels.{locale}.json`)

The sync will use whichever is available.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Project not found | Wrong projectOwner or projectNumber | Check URL and config |
| Fields not updating | Field names don't match exactly | Compare names in Project vs fieldMap |
| Duplicate issues | Missing or changing card_id | Ensure every card has stable card_id |
| Sub-issues not linking | Token lacks permissions | Use PAT with project scope |
| Labels not applied | Labels don't exist in repo | Set CREATE_MISSING_LABELS=true |
