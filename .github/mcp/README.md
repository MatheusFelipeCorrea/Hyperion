# MCP reference servers (Hyperion)

Starter configs for adopters connecting cards-sync backends via MCP.
Copy the snippet for your IDE and replace env placeholders.

## Cursor (`.cursor/mcp.json`)

See [servers.example.json](./servers.example.json) — copy to your product repo as `.cursor/mcp.json`.

| Config key | npm package | Purpose | Required env / args |
|------------|-------------|---------|----------------------|
| `jira` | [`mcp-atlassian`](https://www.npmjs.com/package/mcp-atlassian) | Jira + Confluence issues/fields | `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` |
| `linear` | [`mcp-linear`](https://www.npmjs.com/package/mcp-linear) | Linear issues + workflow | `LINEAR_API_KEY` |
| `azure-devops` | [`@azure-devops/mcp`](https://www.npmjs.com/package/@azure-devops/mcp) (official, Microsoft) | Azure Boards | org name as a CLI arg (not env); auths via `az login` by default |
| `gitlab` | [`mcp-gitlab`](https://www.npmjs.com/package/mcp-gitlab) | GitLab issues | `GITLAB_TOKEN`, `GITLAB_URL` |

Config keys above match the top-level keys in `servers.example.json` exactly — copy the file as-is and only replace env placeholders / the Azure DevOps org name.

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
