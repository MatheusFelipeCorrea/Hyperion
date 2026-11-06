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

Use an absolute path: a relative path is resolved from wherever the client
starts the server, which isn't always the repo root. `${workspaceFolder}` is a
Cursor variable; Claude Desktop doesn't expand it, so there write the full path
(for example `C:/code/my-product/scripts/hyperion/mcp-server.mjs` or
`/opt/code/my-product/scripts/hyperion/mcp-server.mjs`). If the kit lives in a
subfolder (for example `Hyperion/`), add it to the path.

Tools exposed: `hyperion_doctor` (kit + cards-sync health check — may make
real read-only GitHub API calls via your `gh` session/token, never writes;
its "create the Project?" prompts only appear in a terminal, so under MCP
they are always skipped), `hyperion_project_verify` (validates `project.yml`
against its schema, no network calls). Neither tool mutates anything.

## Backend servers (official)

Every backend now has an official MCP server maintained by its vendor. Prefer
these over community packages. Jira, Linear and GitLab run theirs as remote
servers: you sign in with OAuth in the client, so no token sits in `mcp.json`
and nothing is downloaded on every start. Azure DevOps is different: Microsoft
publishes an npm package that runs **on your machine** through `npx`. Unpinned,
`npx` fetches the latest version on each start, so pin a version you reviewed
(`@azure-devops/mcp@<version>`), at least for teams.

| Config key | Server | Endpoint / command | Auth | Requirements |
|------------|--------|--------------------|------|--------------|
| `jira` | [Atlassian Rovo MCP](https://developer.atlassian.com/cloud/rovo-mcp/) (Jira + Confluence) | `https://mcp.atlassian.com/v2/mcp` | OAuth 2.1 (API token if your admin enables it) | **Jira Cloud only.** Calls consume Rovo credits. |
| `linear` | [Linear MCP](https://linear.app/docs/mcp) | `https://mcp.linear.app/mcp/readonly` (read-only) or `https://mcp.linear.app/mcp` | OAuth 2.1 | — |
| `gitlab` | [GitLab MCP server](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) | `https://gitlab.com/api/v4/mcp`, or `https://<your-gitlab>/api/v4/mcp` | OAuth | GitLab 18.6+ (GA in 19.5; available on Free from 19.2). A group owner or instance admin must enable MCP access. |
| `azure-devops` | [`@azure-devops/mcp`](https://www.npmjs.com/package/@azure-devops/mcp) (Microsoft, runs locally) | `npx -y @azure-devops/mcp@<version> <org>` | `az login` | Node.js on the machine running the client |

Clients that only speak stdio (e.g. older Claude Desktop builds) can reach the
remote servers through `npx -y mcp-remote <url>`.

**Jira Data Center / Server:** the Rovo MCP server doesn't cover it. Rely on
cards sync (`backend: jira` with `JIRA_URL` / `JIRA_API_TOKEN` in `.env`), which
talks to the Jira REST API directly; no MCP server is needed.

### Cards stay the source of truth

These servers can create, edit and move issues. Cards-sync treats the Markdown
cards in `.github/cards/` as the source of truth, so an agent that edits the
board directly competes with the next forward sync. Change cards in the repo
and let `npm run cards:sync` push them; use the board MCP to read.

Only Linear enforces that on the server side (`/mcp/readonly`). Atlassian and
GitLab have no read-only endpoint: the server can do anything the signed-in
account can. Sign in with an account that has the least privilege you need,
for example a dedicated user with only read access to the project, rather
than an admin. The same goes for the Azure DevOps identity you `az login` with.

The MCP server is only for reading. Cards sync doesn't use it and still needs
its own token and settings in `.env` (tokens as CI secrets): `JIRA_URL`, `JIRA_EMAIL`,
`JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`; `LINEAR_API_TOKEN`, `LINEAR_TEAM_ID`;
`GITLAB_TOKEN`, `GITLAB_PROJECT_ID` (+ `GITLAB_URL` when self-managed);
`AZDO_ORG_URL`, `AZDO_PROJECT`, `AZDO_PAT`.

### Secrets

- Remote servers above use OAuth — nothing to put in `mcp.json`.
- For stdio servers that need a token, reference the environment instead of
  pasting it. In the Cursor editor, `${env:NAME}` is expanded in `command`,
  `args`, `env`, `url` and `headers`, `"envFile": "${workspaceFolder}/.env"`
  loads a file, and a plain `${NAME}` is **not** expanded: it reaches the
  server as literal text. Other clients, the Cursor CLI included, may
  interpolate differently or not at all; check your client's docs, or put the
  variable in the environment the client is started from.
- Never commit tokens — use `.env` locally (gitignored) and GitHub Actions
  secrets in CI.

### Community packages (legacy)

Earlier versions of this file pointed at `mcp-atlassian`, `mcp-linear` and
`mcp-gitlab` — single-maintainer npm packages started with `npx -y` (latest
version on every launch, with your token in their environment). If your
`.cursor/mcp.json` still uses them, switch to the official servers above.
`npm run cards:doctor` warns whenever one of them is configured, whether it
is started with `npx` or `uvx`.

## Setup flow

1. Pick backend in [choose-backend-en.md](../docs/integration/choose-backend-en.md)
2. Run `/integration-bridge` (integration-bridge skill)
3. Optional, for reading the board from the agent: add the backend's server from the table above to `.cursor/mcp.json` and sign in
4. Point `management.backend` in `project.yml`, configure `projects-map.json`, and put the backend's sync credentials in `.env` (list above). The MCP sign-in doesn't replace them.
5. `npm run cards:doctor` → `npm run cards:sync`

## Notes

- Hyperion ships **reference config only** — it doesn't install or run vendor servers.
- GitHub (default) does **not** require MCP; `gh` CLI + `PROJECT_SYNC_TOKEN` is enough.
- Cards-sync itself never uses MCP: it calls each backend's REST/GraphQL API with the tokens from `.env` / CI secrets.
