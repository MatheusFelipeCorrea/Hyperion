---
name: integration-bridge
description: >-
  Prepares Hyperion integration with external project management tools (Jira,
  Azure DevOps, Linear, GitLab) via MCP or API. It configures the bridge and
  maps fields. Sync engine: all backends support forward + reverse (frontmatter
  patch on reverse); Linear status via status_map.
---

# Integration Bridge

Configures and manages connections between Hyperion cards and external project
management tools.

## Output

| Artifact | Path |
|----------|------|
| Backend choice + field mapping summary | `.github/memory/DECISIONS.md` (append section) |
| Backend flag | `.github/project.yml` → `management.backend` (+ url, project_key, etc.) |
| Env var guidance | Point user to `.env` (never commit secrets) |
| GitHub sync config | `.github/cards/config/projects-map.json` (GitHub only) |

Cards remain in `.github/cards/` — sync engine reads from there regardless of backend.

## Supported Backends

| Backend | Connection method | Card sync | Bidirectional |
|---------|------------------|-----------|---------------|
| **GitHub** (default) | GitHub API / gh CLI | Full (Issues + Projects + fields) | Yes (`--reverse`) |
| **Jira** | MCP (`mcp-jira`) or REST API | Forward + reverse in `sync.mjs` | Yes (`--reverse` rebuilds Markdown) |
| **Azure DevOps** | MCP (`mcp-azure-devops`) or REST API | Forward + reverse; `System.State` via `status_map` | Yes (`--reverse`) |
| **Linear** | MCP (`mcp-linear`) or GraphQL | Forward + reverse; workflow state via `status_map` | Yes (`--reverse`) |
| **GitLab** | MCP (`mcp-gitlab`) or REST API | Forward + reverse; open/close + `status:` label | Yes (`--reverse`) |

## Step 1 — Detect current backend

Check in order:
1. `project.yml` → `management.backend` field
2. Config files in repo: `.jira.yml`, `azure-pipelines.yml`, `.linear/`
3. MCP servers available in current session
4. Ask the user

### MCP availability handshake (best effort)

If you have MCP tool access in this runtime:
- attempt a harmless MCP call (e.g. list projects/teams)
- if the tool is not available (tool-not-found / unsupported), fall back to REST/API steps and ask the user for the required token/URL.

## Step 2 — Configure connection

### For GitHub (default)
Already configured via `projects-map.json`. No extra setup needed.

### For Jira
1. Verify MCP `mcp-jira` is available, OR ask for API token
2. Gather: Jira URL, project key, email
3. Update `project.yml`:
   ```yaml
   management:
     backend: jira
     url: https://org.atlassian.net
     project_key: PROJ
   ```
4. Configure runtime env vars for Jira sync:
   - `JIRA_URL`
   - `JIRA_PROJECT_KEY`
   - `JIRA_EMAIL`
   - `JIRA_API_TOKEN`
   - optional `JIRA_ISSUE_TYPE` (default `Task`)
5. Create field mapping in `projects-map.json`:
   ```json
   {
     "fieldMap": {
       "status": "status",
       "type": "issuetype",
       "priority": "priority",
       "sprint": "customfield_10020",
       "storyPoints": "customfield_10028",
       "parent": "parent"
     }
   }
   ```

### For Azure DevOps
1. Verify MCP `mcp-azure-devops` is available, OR ask for PAT
2. Gather: organization URL, project name
3. Update `project.yml`:
   ```yaml
   management:
     backend: azure-devops
     org: https://dev.azure.com/my-org
     project: MyProject
   ```
4. Map work item types:
   - Epic → Epic
   - Feature → Feature
   - Story → User Story
   - Task → Task

### For Linear
1. Verify MCP `mcp-linear` is available, OR ask for API key
2. Gather: team identifier
3. Update `project.yml`:
   ```yaml
   management:
     backend: linear
     team: my-team
   ```

### For GitLab
1. Verify MCP `mcp-gitlab` is available, OR ask for token
2. Gather: project URL
3. Update `project.yml`:
   ```yaml
   management:
     backend: gitlab
     project_url: https://gitlab.com/org/repo
   ```

## Step 3 — Field mapping

Create a mapping between Hyperion card frontmatter fields and the external tool's fields:

| Hyperion field | GitHub | Jira | Azure DevOps | Linear | GitLab |
|---------------|--------|------|--------------|--------|--------|
| `card_id` | Issue title prefix | Issue key | Work Item ID | Issue ID | Issue IID |
| `type` | Label | Issue Type | Work Item Type | Label | Label |
| `priority` | Project field | Priority | Priority | Priority | Label |
| `sprint` | Project iteration | Sprint | Iteration Path | Cycle | Milestone |
| `story_points` | Project field | Story Points | Story Points | Estimate | — |
| `parent` | Sub-issue link | Parent link | Parent link | Parent | — |
| `labels` | Labels | Labels/Components | Tags | Labels | Labels |
| `status` | Project Status column | Description metadata | Description metadata | Description metadata | Description metadata |

## Step 4 — Test connection

1. Run a dry-run sync: `npm run hyperion:sync -- --dry-run`
2. For Jira backend, run:
   - `CARDS_SYNC_BACKEND=jira npm run hyperion:sync -- --dry-run`
   - `CARDS_SYNC_BACKEND=jira npm run hyperion:sync`
3. Verify card/frontmatter schema and field mapping consistency
4. For Azure/Linear/GitLab backends, run dry-run forward sync; `doctor.mjs` remote checks cover GitHub/Jira only today

### Card evolution after setup

When the user asks to move or update a card in conversation (e.g. "mova PROJ-STORY-001 para Done"):
1. Agent edits the existing `.github/cards/**/*.md` file (never duplicates)
2. Runs `validate.mjs` → `sync.mjs`
3. **GitHub:** Project Status column updates on forward sync
4. **Jira/other:** status written to description metadata; native board state not mapped yet

See `card-refiner` skill § Card evolution during conversation.

## Step 5 — Document

Save the integration config summary to `.github/memory/DECISIONS.md`:
- Which backend was chosen and why
- Field mapping decisions
- Authentication method (without secrets)

## MCP Integration Guide

When MCP servers are available, the agent can interact directly:

```
# Jira via MCP
mcp-jira: create_issue, update_issue, search_issues, get_project

# Azure DevOps via MCP  
mcp-azure-devops: create_work_item, update_work_item, get_boards

# Linear via MCP
mcp-linear: create_issue, update_issue, get_team_issues

# GitLab via MCP
mcp-gitlab: create_issue, update_issue, list_project_issues
```

If no MCP is available, fall back to REST API calls via the sync script.

## Rules

- Never store tokens/secrets in committed files — use environment variables or secrets
- Always test with dry-run before real sync (GitHub Projects engine)
- Respect rate limits of external APIs
- If MCP is available, prefer it over direct API calls (better auth handling)
- This kit syncs real card data to GitHub (full), Jira/Azure/GitLab/Linear (forward + reverse). GitHub Projects remains the richest native-column path.
- Keep backward compatibility — GitHub remains the default zero-config path

## Example

> "Connect this project to our Jira"
> → Checks for mcp-jira availability, asks for project URL and key,
>   creates field mapping, tests with one card, documents the decision.
