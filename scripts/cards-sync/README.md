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

Migrate legacy flat files: `npm run cards:migrate-layout` (preview by default) then `npm run cards:migrate-layout -- --yes` to move files for real. Validate warns on flat leftovers; `cards:validate --strict-layout` fails them.

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

**Other backends:**
- **GitLab** — `cards:labels-reset` works the same way, over GitLab's Labels REST API (`GITLAB_PROJECT_ID` + `GITLAB_TOKEN`, optional `GITLAB_URL`). GitLab projects ship with no default labels, so there's no GitHub-defaults special case — any non-catalog, non-Dependabot label is still treated as an orphan.
- **Azure DevOps** — nothing to reset. `System.Tags` is free-text with no color/description/catalog concept in the REST API at all, so there's no metadata-drift or orphan-cleanup problem this tool solves there. `cards:labels-reset` explains this and exits cleanly if the backend is Azure.
- **Linear** — nothing to reset either, but for a different reason: forward sync resolves `card.categories` to Linear `IssueLabel`s directly, creating any that don't exist on the team yet (get-or-create, same spirit as `CREATE_MISSING_LABELS` for GitHub/GitLab) — see `linearResolveLabelIds` in `scripts/cards-sync/backends/linear.mjs`. Reverse sync reads the real labels back the same way GitHub/GitLab do. `cards:labels-reset` explains this and exits cleanly if the backend is Linear.

**Project views:** on create/sync, Hyperion configures tabs in order: **Board** → **Tabela** → **Roadmap** (user can customize filters/grouping in the UI afterward).

**Status columns (board):** workflow columns come from `status-columns.{locale}.json` (via `statusColumnsFile` in `projects-map.json`). Each entry has `key` (canonical English status), `color` (GitHub enum: GRAY, BLUE, GREEN, …), and `description` shown in Project field settings. Names on the board are localized through `optionMapByLocale.status`. Forward sync updates missing columns and refreshes color/description when metadata drifts.

Default semantic palette:

| Column | Color |
|--------|-------|
| Backlog | GRAY |
| Functional Refinement | BLUE |
| Technical Refinement | PURPLE |
| In Progress | YELLOW |
| In Tests | PINK |
| In Revision | ORANGE |
| Done | GREEN |

**Overlay (repo/domain-specific labels or columns):** drop `.github/cards/config/labels.custom.json` and/or `status-columns.custom.json` next to the locale catalogs, same array shape as `labels.{locale}.json` / `status-columns.{locale}.json`. Both are merged into the base catalog on every load (`labels-reset`, forward sync, `doctor`) — an entry with a `name`/`key` already in the base catalog overrides it, a new one is appended. This is how a product adds domain-specific labels (e.g. `Payment`, `Search`) or extra board columns without forking the kit's generic default catalog. `hyperion:doctor`/`cards:doctor` reports whether an overlay file is present.

**Sprint field:** auto-created as GitHub **Iteration** (`Sprint` / `Número da Sprint`). Cards may keep `sprint: null`; define sprint dates in Project Settings. Configure defaults in `projects-map.json` → `sprintField` (`durationDays`, optional `seedIterations`).

**Fix fields on an existing Project:** forward sync only creates the 8 required fields (Status, Type, Priority, Sprint, Story Points, Reporter, Parent, Due Date) when it auto-creates a brand-new Project. If you already have a Project and `cards:doctor` reports missing/misnamed fields, fix that Project in place instead of recreating it:

```bash
npm run cards:project-fields-apply             # preview (dry-run by default)
npm run cards:project-fields-apply -- --yes    # create missing fields, rename ones under an alias
```

Requires `projects-map.json` to already have a `projectNumber` set — it fixes fields on an existing Project, it doesn't auto-create one (use `cards:sync` for that).

**Issue body enrichment (GitHub forward sync):** after create/update, sync rewrites the issue body with:
- Clickable **Parent** and **Sub-issues** links (`[CARD_ID (#n)](url)`)
- Optional section emoji headers (`## Resumo` → `## 📋 Resumo`) if not already present
- **🔄 Hyperion sync** blockquote (card id, parent, source path) + machine-readable `CARD_ID` metadata

**Unit tests:** `npm run cards:test` (27+ tests for parsers, mapping, body enrichment). These mock `global.fetch` — no test in this suite ever calls a real GitHub/Jira/Azure/Linear/GitLab API.

### End-to-end test (opt-in)

Two scripts close the gap the unit tests can't — both drive the **real** `sync.mjs` against a **disposable** GitHub repo:

- `scripts/cards-sync/e2e/e2e-forward-sync.mjs` — runs a real forward sync, then asserts the resulting Issue(s) actually exist with the right title/labels/body.
- `scripts/cards-sync/e2e/e2e-reverse-sync.mjs` — runs a real forward sync to create one issue, edits that issue's title and labels **directly via the GitHub API** (simulating someone editing it on the board), deletes the local card file, then runs a real reverse sync and asserts the *recreated* local file picked up the board's title and label. Scoped to title/label roundtrip only — the fixture is Issues-only (no GitHub Project board, same as the forward test), so there's no real board-driven Status field to verify without faking the thing the test is supposed to prove.

Both delete everything they created afterward (`try`/`finally`, runs even on assertion failure), and are **opt-in only** — neither ever runs automatically:
- Neither is part of `npm test` / `npm run cards:test` (they don't match the `scripts/cards-sync/*.test.mjs` glob — they live in `scripts/cards-sync/e2e/`).
- Their GitHub Actions workflow, `.github/workflows/hyperion-e2e-cards.yml`, is triggered **only** by `workflow_dispatch` — never `push`/`pull_request` — so it can't run against a contributor's PR or a push to this repo. The workflow has one job per script (`e2e-forward-sync`, `e2e-reverse-sync`), both using the same `E2E_TARGET_REPO`/`E2E_GITHUB_TOKEN`.

**One-time maintainer setup:**
1. Create a separate, disposable GitHub repo you own (e.g. `your-user/hyperion-e2e-sandbox`) — never this repo. It just needs to exist; the tests create and delete their own issues/labels in it.
2. In this repo's Settings → Secrets and variables → Actions, add:
   - Variable **`E2E_TARGET_REPO`** = `your-user/hyperion-e2e-sandbox`
   - Secret **`E2E_GITHUB_TOKEN`** = a PAT scoped to that disposable repo with `Issues: Read and write` + `Contents: Read` (a fine-grained PAT limited to that one repo is safest).
3. Trigger it: Actions → **Hyperion — E2E Cards Sync (opt-in)** → Run workflow.

Run either locally instead of via Actions:

```bash
E2E_TARGET_REPO="your-user/hyperion-e2e-sandbox" \
E2E_GITHUB_TOKEN="ghp_xxx" \
  node scripts/cards-sync/e2e/e2e-forward-sync.mjs

E2E_TARGET_REPO="your-user/hyperion-e2e-sandbox" \
E2E_GITHUB_TOKEN="ghp_xxx" \
  node scripts/cards-sync/e2e/e2e-reverse-sync.mjs
```

Without `E2E_TARGET_REPO` / a token, each script fails fast with a clear error instead of crashing — and each also refuses to run if `E2E_TARGET_REPO` resolves to the same repo the script is running from.

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
# At an interactive terminal this asks you to type "yes" first — it's a
# real write to your live board. Skip the prompt with --yes or
# CARDS_SYNC_YES=true (CI never prompts either way — no TTY there).

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

# Flow metrics — WIP by status + average cycle time, mined from git log
# (no board API call; just the status: frontmatter you already commit)
npm run cards:metrics
npm run cards:metrics -- --json

# Sync operation log — reads sync-history.jsonl back (forward-sync runs +
# PR board-guard checks): counts by event type, ok/fail, most recent events.
# Distinct from cards:metrics, which is about card status over time, not
# sync runs themselves.
npm run cards:history
npm run cards:history -- --json
npm run cards:history -- --limit 5

# Slack/Discord notification for a sync result — opt-in, no-ops silently
# if neither webhook env var is set. hyperion-sync-cards.yml already runs
# this after every sync attempt (if: always()).
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..." npm run cards:notify
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run cards:notify
npm run cards:notify -- --message "Custom text"   # skip reading sync-history.jsonl
```

## GitHub automation

**Prerequisite (local):** [GitHub CLI — install and login](../../.github/docs/integration/github-cli-setup.md) (`gh auth login`). The sync reads `gh auth token` automatically.

| Feature | How |
|---------|-----|
| Auto-detect repo | `git remote get-url origin` |
| Auto-detect token | `gh auth token` |
| Auto-discover Project | Lists repo Projects; picks `[RepoName] Hyperion Project`, any Hyperion title, or sole project; saves `projectNumber` |
| Auto-create Project | When **no** project exists and discovery is unambiguous (`autoCreateProject: true`) — skipped when multiple candidates exist |
| Issue body links | Parent, sub-issues, Hyperion footer on forward sync |
| Incremental sync | `--only CARD_ID,...` or `CARDS_SYNC_ONLY` env (watch uses this); loads all issues for link resolution |
| Sync summary | Writes `.github/plans/cards/last-sync.md` after each forward sync |
| Sync history | Appends JSON lines to `.github/plans/cards/sync-history.jsonl` (forward-sync + pr-guard events) |
| Pre-commit hook | `npm run cards:hook` validates staged `.github/cards/*.md` |
| **PR board guard** | `hyperion-cards-pr-check.yml` — directional reverse + diff; blocks **external** board drift only |
| **Main CI sync** | `hyperion-sync-cards.yml` — pull → verify → push after merge to main |

**Branch workflow:** create/edit cards on a feature branch (forward sync is skipped locally by `watch` and does not run until main). Open a PR → PR guard ensures board and branch agree → merge → main CI pushes to the Project.

Mark **Hyperion — Cards PR Board Guard** as a required status check in GitHub Branch protection.

Disable auto-discovery: set `"autoDiscoverProject": false` in `projects-map.json`.

### Running the PR board guard outside GitHub Actions

The guard itself (`pr-board-guard.mjs`) doesn't hard-depend on GitHub Actions — the two env vars that matter for CI wiring already have generic names:

| Env var | GitHub Actions equivalent | What to set it to elsewhere |
|---------|---------------------------|------------------------------|
| `CARDS_GUARD_BASE_REF` | (auto: `GITHUB_BASE_SHA`) | The target/base branch SHA of the merge request — e.g. GitLab CI's `CI_MERGE_REQUEST_DIFF_BASE_SHA`, Azure Pipelines' `System.PullRequest.TargetBranch` resolved to a SHA |
| `CARDS_SYNC_BACKEND` | (defaults to `github`) | `jira`, `azure-devops`, `linear`, or `gitlab` — same value used everywhere else in this README |

```bash
# GitLab CI (.gitlab-ci.yml), only block/blocked syntax shown
board-guard:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  script:
    - node scripts/cards-sync/pr-board-guard.mjs
  variables:
    CARDS_GUARD_BASE_REF: $CI_MERGE_REQUEST_DIFF_BASE_SHA
```

What's GitHub-specific: `report-pr-guard-check.mjs` (posts a GitHub Check Run via the REST API) and the ready-made `hyperion-cards-pr-check.yml`/`hyperion-cards-pr-recheck.yml` workflows. On another CI platform, skip that script and just let the guard's own exit code fail the pipeline job directly — you lose the separate check-run annotation, not the guard itself.

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
| CARDS_SYNC_CONCURRENCY | Optional | Max cards processed in flight at once per sync phase (default `4`). Lower it if a large board's first sync trips GitHub's secondary rate limits; `1` reproduces the old fully-sequential behavior. |
| CARDS_SYNC_YES | Optional | "true" to skip the interactive "type yes" confirmation before a live (non-dry-run) sync at a terminal — same effect as `--yes`. Never needed in CI (no TTY, never prompts). |
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

### Adding a new backend (e.g. Trello, ClickUp)

The 4 non-GitHub backends (`scripts/cards-sync/backends/{jira,azure,gitlab,linear}.mjs`) all follow the same shape now — Azure/GitLab/Linear only reached parity with Jira's hierarchy linking this round, so the pattern below is genuinely the same across all four, not just "close enough":

1. **New file**: `scripts/cards-sync/backends/<name>.mjs`, exporting `runForwardSync<Name>(repoConfig, management)` and `runReverseSync<Name>(repoConfig, management)`.
2. **Reuse, don't reimplement**, from `../lib.mjs`: `parseCardFile`, `buildEdges`, `buildIssueTitle`, `buildRemoteDescriptionFromCard`, `parseCardIdFromIssueBody`, `parseSourceFileFromIssueBody`, `parseSyncMetadataFromDescription`, `remoteIssueToCardMarkdown`, `resolveHyperionStatusFromRemote`, `remoteBoardSyncAt`. And from `../sync.mjs`: `log`, `dryRun`, `cardsRoot`, `workspaceRoot`, `cardsPrefix`, `listMarkdownFiles`, `applyKitSampleFilter`, `applyReverseCardFileUpdate`, `countReverseWrite`.
3. **Idempotency**: every remote item's body/description must embed the `CARD_ID:` sync marker (see `buildRemoteDescriptionFromCard`'s output) — forward sync finds-or-creates by searching for it, exactly like the 4 existing backends.
4. **Own request helper**: a small function (e.g. `<name>Request(endpoint, method, body)` or a GraphQL equivalent) closing over the API base URL/token from `management`. Raw `fetch`, not a vendor SDK — matches every backend in this kit (and the first-party MCP server).
5. **Parent-child linking**: write it as a **standalone exported function taking the request helper as its first parameter** — `async function <name>LinkIssues(requestFn, childId, parentId)` — not a closure over a local variable. That's what makes it unit-testable with a stub instead of mocking `global.fetch`; see `backends/linking.test.mjs` for the pattern all 4 existing backends use, and add your new one there too.
6. **Reverse sync shape**: for each remote item with a `CARD_ID:` marker, parse `SOURCE_FILE`/`CARD_ID`, derive `hyperionStatus` via `resolveHyperionStatusFromRemote(remoteStatus, statusMap, repoConfig)`, build `converted` via `remoteIssueToCardMarkdown({ title, description, labels, statusOverride })`, then call `applyReverseCardFileUpdate({ sourceFile, cardId, remoteUpdates, converted, logLabel })` — it handles both the patch-existing-file and create-new-file cases for you.
7. **Wire it into `sync.mjs`**: add a `backend === "<name>"` branch next to the existing 4 in both `runForwardSync()` (around the `if (backend === "gitlab")` block) and `runReverseSync()` (the mirroring block further down) — import your two new functions at the top of `sync.mjs`.
8. **`doctor.mjs`**: add a connectivity check block (env vars required, one real read-only API call to confirm they work) — copy the shape of the Azure/GitLab/Linear blocks, they're all the same length.
9. **`labels-reset.mjs`**: only relevant if the backend has a real label/tag catalog with color+description (GitLab does; Azure's Tags don't — see the comment in that file for why Azure is skipped there).
10. Configure connection + field mapping for real usage via the `integration-bridge` skill once the adapter exists.

Card categories/labels, status mapping (`status_map`), and the `CARD_ID`/`SOURCE_FILE` sync markers are backend-agnostic — you're translating Hyperion's card model to the new API's shape, not inventing new conventions.

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
