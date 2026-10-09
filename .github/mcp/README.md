# MCP reference servers (Hyperion)

Starter configs for adopters connecting cards-sync backends via MCP.
Copy [servers.example.json](./servers.example.json) to your product repo as
`.cursor/mcp.json` and keep only the servers you use.

## First-party: Hyperion itself (read-only)

Unlike the backend connectors below, `scripts/hyperion/mcp-server.mjs` isn't a
board integration — it exposes the kit's own **read-only** commands
(`doctor`, `project-verify`) as MCP tools, so any MCP-capable client (Claude
Desktop, Cursor, etc.) can run them directly instead of shelling out. No
third-party package, no new dependency — it implements the MCP stdio
JSON-RPC transport by hand, the same way this kit's other protocol clients
(GitHub/Jira/Linear/GitLab) are raw `fetch` calls instead of vendor SDKs.

```json
{
  "mcpServers": {
    "hyperion": {
      "command": "node",
      "args": ["${workspaceFolder}/scripts/hyperion/mcp-server.mjs"]
    }
  }
}
```

Use an absolute path (`${workspaceFolder}/…` in Cursor): a relative path is
resolved from wherever the client starts the server, which isn't always the
repo root. If the kit lives in a subfolder (for example `Hyperion/`), add it
to the path.

Tools exposed: `hyperion_doctor` (kit + cards-sync health check — may make
real read-only GitHub API calls via your `gh` session/token, never writes;
its "create the Project?" prompts only appear in a terminal, so under MCP
they are always skipped), `hyperion_project_verify` (validates `project.yml`
against its schema, no network calls). Neither tool mutates anything.

## Backend servers (official)

Every backend now has a vendor-run MCP server. Prefer these over community
packages: you sign in with OAuth in the client, so no token sits in
`mcp.json`, and nothing is downloaded from npm on every start.

| Config key | Server | Endpoint / command | Auth |
|------------|--------|--------------------|------|
| `jira` | [Atlassian Rovo MCP](https://developer.atlassian.com/cloud/rovo-mcp/) (Jira + Confluence) | `https://mcp.atlassian.com/v2/mcp` | OAuth 2.1 (API token if your admin enables it) |
| `linear` | [Linear MCP](https://linear.app/docs/mcp) | `https://mcp.linear.app/mcp/readonly` (read-only) or `https://mcp.linear.app/mcp` | OAuth 2.1 |
| `gitlab` | [GitLab MCP server](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) (GitLab 18.3+) | `https://gitlab.com/api/v4/mcp`, or `https://<your-gitlab>/api/v4/mcp` | OAuth |
| `azure-devops` | [`@azure-devops/mcp`](https://www.npmjs.com/package/@azure-devops/mcp) (Microsoft) | `npx -y @azure-devops/mcp <org>` | `az login` |

Clients that only speak stdio (e.g. older Claude Desktop builds) can reach the
remote servers through `npx -y mcp-remote <url>`.

### Cards stay the source of truth

These servers can create, edit and move issues. Cards-sync treats the Markdown
cards in `.github/cards/` as the source of truth, so an agent that edits the
board directly competes with the next forward sync. Change cards in the repo
and let `npm run cards:sync` push them; use the board MCP to read (Linear's
`/mcp/readonly` endpoint enforces that).

### Secrets

- Remote servers above use OAuth — nothing to put in `mcp.json`.
- For stdio servers that need a token, reference the environment instead of
  pasting it: Cursor expands `${env:NAME}` in `command`, `args`, `env`, `url`
  and `headers`, or loads a file with `"envFile": "${workspaceFolder}/.env"`.
  A plain `${NAME}` is **not** expanded and reaches the server as literal text.
- Never commit tokens — use `.env` locally (gitignored) and GitHub Actions
  secrets in CI.

### Community packages (legacy)

Earlier versions of this file pointed at `mcp-atlassian`, `mcp-linear` and
`mcp-gitlab` — single-maintainer npm packages started with `npx -y` (latest
version on every launch, with your token in their environment). If your
`.cursor/mcp.json` still uses them, switch to the official servers above;
`npm run cards:doctor` warns when one of them hasn't been published in a long
time.

## Setup flow

1. Pick backend in [choose-backend-en.md](../docs/integration/choose-backend-en.md)
2. Run `/integration-bridge` (integration-bridge skill)
3. Add the backend's server from the table above to `.cursor/mcp.json` and sign in
4. Point `management.backend` in `project.yml` and configure `projects-map.json` / env vars
5. `npm run cards:doctor` → `npm run cards:sync`

## Notes

- Hyperion ships **reference config only** — it doesn't install or run vendor servers.
- GitHub (default) does **not** require MCP; `gh` CLI + `PROJECT_SYNC_TOKEN` is enough.
- Cards-sync itself never uses MCP: it calls each backend's REST/GraphQL API with the tokens from `.env` / CI secrets.
