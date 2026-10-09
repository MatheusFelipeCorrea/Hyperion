import test from "node:test";
import assert from "node:assert/strict";
import { findLegacyMcpServers, packageNameOf } from "./mcp-legacy.mjs";

test("packageNameOf strips versions, scopes stay, image refs reduce to the name", () => {
  assert.equal(packageNameOf("mcp-linear"), "mcp-linear");
  assert.equal(packageNameOf("mcp-linear@0.1.3"), "mcp-linear");
  assert.equal(packageNameOf("@azure-devops/mcp@2.2.0"), "@azure-devops/mcp");
  assert.equal(packageNameOf("@azure-devops/mcp"), "@azure-devops/mcp");
  assert.equal(packageNameOf("mcp-atlassian==0.11.9"), "mcp-atlassian");
  assert.equal(packageNameOf("ghcr.io/sooperset/mcp-atlassian:latest"), "mcp-atlassian");
});

test("findLegacyMcpServers flags any legacy community package, not only stale ones", () => {
  const config = {
    mcpServers: {
      jira: { command: "uvx", args: ["mcp-atlassian"] },
      tracker: { command: "npx", args: ["-y", "mcp-linear@0.1.3"], env: { LINEAR_API_KEY: "${env:LINEAR_API_KEY}" } },
      gl: { command: "npx.cmd", args: ["-y", "mcp-gitlab"] },
      ado: { command: "npx", args: ["-y", "@azure-devops/mcp", "my-org"] },
      hyperion: { command: "node", args: ["${workspaceFolder}/scripts/hyperion/mcp-server.mjs"] },
      linear: { url: "https://mcp.linear.app/mcp/readonly" },
    },
  };
  assert.deepEqual(findLegacyMcpServers(config), [
    { server: "jira", pkg: "mcp-atlassian", backend: "jira" },
    { server: "tracker", pkg: "mcp-linear", backend: "linear" },
    { server: "gl", pkg: "mcp-gitlab", backend: "gitlab" },
  ]);
});

test("findLegacyMcpServers tolerates empty or malformed configs", () => {
  assert.deepEqual(findLegacyMcpServers(null), []);
  assert.deepEqual(findLegacyMcpServers({}), []);
  assert.deepEqual(findLegacyMcpServers({ mcpServers: { x: null, y: { args: "mcp-linear" } } }), []);
});
