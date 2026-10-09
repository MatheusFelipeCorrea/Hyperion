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
| **Jira** | Sync: REST API + `JIRA_*` token. Reading: optional Atlassian Rovo MCP (Jira Cloud only) | Forward + reverse (`backends/jira.mjs`) | Yes (`--reverse` rebuilds Markdown) |
| **Azure DevOps** | Sync: REST API + `AZDO_PAT`. Reading: optional `@azure-devops/mcp` | Forward + reverse; `System.State` via `status_map` | Yes (`--reverse`) |
| **Linear** | Sync: GraphQL + `LINEAR_API_TOKEN`. Reading: optional Linear MCP | Forward + reverse; workflow state via `status_map` | Yes (`--reverse`) |
| **GitLab** | Sync: REST API + `GITLAB_TOKEN`. Reading: optional GitLab MCP (18.6+) | Forward + reverse; open/close + `status:` label | Yes (`--reverse`) |

## Step 1 — Detect current backend

Reference MCP configs: `.github/mcp/servers.example.json` + [mcp/README.md](../../../mcp/README.md).

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

> **MCP reads, sync writes.** A connected board MCP server only helps the agent *read* the board (find the project, issue types, existing issues). Cards sync never uses it: every backend below still needs its token and settings in `.env` locally and as CI secrets, whether or not MCP is connected. MCP servers are listed in [mcp/README.md](../../../mcp/README.md).

### For Jira
1. If the Atlassian MCP server is connected, use it to look up the project key and issue types. It is **Jira Cloud only** and each call consumes Rovo credits; on Jira Data Center / Server skip it and rely on cards sync alone.
2. Ask for an API token anyway: sync needs it. Gather: Jira URL, project key, email
3. Update `project.yml`:
   ```yaml
   management:
     backend: jira
     url: https://org.atlassian.net
     project_key: PROJ
   ```
4. Configure runtime env vars for Jira sync in `.env` (required even with MCP connected):
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
1. If `@azure-devops/mcp` is connected, use it to look up the project and work item types.
2. Ask for a PAT anyway: sync needs `AZDO_ORG_URL`, `AZDO_PROJECT` and `AZDO_PAT` in `.env`. Gather: organization URL, project name
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
1. If the Linear MCP server is connected, use it to look up the team.
2. Ask for an API key anyway: sync needs `LINEAR_API_TOKEN` and `LINEAR_TEAM_ID` in `.env`. Gather: team identifier
3. Update `project.yml`:
   ```yaml
   management:
     backend: linear
     team: my-team
   ```

### For GitLab
1. If the GitLab MCP server is connected (GitLab 18.6+, enabled by a group owner or instance admin), use it to look up the project.
2. Ask for a token anyway: sync needs `GITLAB_TOKEN` and `GITLAB_PROJECT_ID` (+ `GITLAB_URL` when self-managed) in `.env`. Gather: project URL
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

Server endpoints and auth are in [mcp/README.md](../../../mcp/README.md). Tool
names differ per server and change over time — list the tools your client
exposes instead of assuming names.

Use board MCP tools to **read** (find the project, team, issue types, existing
issues). Don't create, edit or move board issues through MCP: cards in
`.github/cards/` are the source of truth, so change the card and run the sync
instead — a direct board edit is overwritten or duplicated by the next forward
sync.

Only Linear has a read-only endpoint (`/mcp/readonly`). Atlassian and GitLab
don't, so their servers can do whatever the signed-in account can: suggest a
least-privilege account (read access to the project only) for the MCP sign-in.

If no MCP is available, ask the user for the same details. Sync behaves the
same either way: it calls the backend's REST/GraphQL API with the tokens in
`.env`.

## Rules

- Never store tokens/secrets in committed files — use environment variables or secrets
- Always test with dry-run before real sync (GitHub Projects engine)
- Respect rate limits of external APIs
- If MCP is available, prefer it over direct API calls for reading the board (better auth handling); writes always go through cards + sync
- This kit syncs real card data to GitHub (full), Jira/Azure/GitLab/Linear (forward + reverse). GitHub Projects remains the richest native-column path.
- Keep backward compatibility — GitHub remains the default zero-config path

## Example

> "Connect this project to our Jira"
> → Checks whether the Atlassian MCP server is connected, asks for project URL and key,
>   creates field mapping, tests with one card, documents the decision.
