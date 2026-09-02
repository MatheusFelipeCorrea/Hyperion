# MCP reference servers (Hyperion)

Starter configs for adopters connecting cards-sync backends via MCP.
Copy the snippet for your IDE and replace env placeholders.

## Cursor (`.cursor/mcp.json`)

See [servers.example.json](./servers.example.json) — copy to your product repo as `.cursor/mcp.json`.

| Server | Purpose | Required env |
|--------|---------|--------------|
| `mcp-jira` | Jira issues + fields | `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| `mcp-linear` | Linear issues + workflow | `LINEAR_API_KEY` |
| `mcp-azure-devops` | Azure Boards | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT` |
| `mcp-gitlab` | GitLab issues | `GITLAB_TOKEN`, `GITLAB_URL` |

## Setup flow

1. Pick backend in [choose-backend-en.md](../docs/integration/choose-backend-en.md)
2. Run `/integration-bridge` (integration-bridge skill)
3. Install the MCP server package your org uses (Atlassian, Linear, etc.)
4. Point `management.backend` in `project.yml` and configure `projects-map.json` / env vars
5. `npm run cards:doctor` → `npm run cards:sync`

## Notes

- Hyperion ships **reference config only** — MCP server binaries come from your vendor or internal registry.
- GitHub (default) does **not** require MCP; `gh` CLI + `PROJECT_SYNC_TOKEN` is enough.
- Never commit tokens — use `.env` locally and GitHub Actions secrets in CI.
