/**
 * Community MCP packages earlier versions of .github/mcp/servers.example.json
 * pointed at. Each backend now has an official server (.github/mcp/README.md),
 * so `cards:doctor` flags any of these still configured in .cursor/mcp.json.
 */
export const LEGACY_MCP_PACKAGES = Object.freeze({
  "mcp-atlassian": "jira",
  "mcp-linear": "linear",
  "mcp-gitlab": "gitlab",
});

/** "pkg@1.2.3" / "@scope/pkg@1" / "pkg==0.11" / "ghcr.io/org/pkg:tag" → bare package name. */
export function packageNameOf(arg) {
  let s = String(arg).trim();
  s = s.split(/[=<>~!]=?/)[0];
  if (s.startsWith("@")) {
    const at = s.indexOf("@", 1);
    return at > 0 ? s.slice(0, at) : s;
  }
  s = s.split("@")[0];
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1).split(":")[0];
  return s;
}

/**
 * Servers in an MCP config (`{ mcpServers: { name: { command, args } } }`) that
 * start a legacy community package, whatever the runner (npx, uvx, docker…).
 * @returns {{ server: string, pkg: string, backend: string }[]}
 */
export function findLegacyMcpServers(config) {
  const found = [];
  for (const [server, def] of Object.entries(config?.mcpServers || {})) {
    if (!def || !Array.isArray(def.args)) continue;
    for (const arg of def.args) {
      if (typeof arg !== "string" || arg.startsWith("-")) continue;
      const pkg = packageNameOf(arg);
      if (Object.hasOwn(LEGACY_MCP_PACKAGES, pkg)) {
        found.push({ server, pkg, backend: LEGACY_MCP_PACKAGES[pkg] });
        break;
      }
    }
  }
  return found;
}
