#!/usr/bin/env node
/**
 * Minimal, first-party MCP server exposing Hyperion's own read-only
 * commands (doctor, project-verify) as MCP tools — no mutations, no board
 * writes. Motivation: 3 of the 4 backend MCP servers this kit documents in
 * .github/mcp/README.md are single-maintainer community packages; this one
 * needs no third-party dependency at all.
 *
 * Implements the MCP stdio JSON-RPC transport by hand (newline-delimited
 * JSON-RPC 2.0 messages, no @modelcontextprotocol/sdk dependency) — this
 * kit's only two runtime dependencies are ajv and js-yaml, and every other
 * protocol client in it (GitHub/Jira/Linear/GitLab GraphQL/REST) is a raw
 * `fetch` call rather than a vendor SDK. Same convention here.
 *
 * Run: node scripts/hyperion/mcp-server.mjs
 *      npm run hyperion:mcp-server
 * Config (e.g. .cursor/mcp.json, Claude Desktop config):
 *   { "command": "node", "args": ["scripts/hyperion/mcp-server.mjs"] }
 *
 * Protocol notes:
 *   - Every response goes to STDOUT, one JSON object per line. Every log
 *     line goes to STDERR. Never console.log() anything that isn't a
 *     protocol response — that would corrupt the stream for the client.
 *   - A JSON-RPC message with no `id` is a notification: never reply to it.
 */
import readline from "node:readline";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "hyperion";
const SERVER_VERSION = "0.2.0";

function logErr(msg) {
  process.stderr.write(`[hyperion-mcp] ${msg}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Runs a kit script as a subprocess and returns its combined output —
 * both doctor.mjs and project-verify.mjs are non-interactive and read-only,
 * so a plain spawnSync capture is safe (no stdin to forward, no prompts to
 * hang on). */
function runKitScript(scriptName, args = []) {
  const scriptPath = path.join(scriptDir, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(scriptDir, "..", ".."),
    encoding: "utf8",
    env: process.env,
  });
  const parts = [];
  if (result.stdout) parts.push(result.stdout.trimEnd());
  if (result.stderr) parts.push(result.stderr.trimEnd());
  const text = parts.join("\n").trim() || "(no output)";
  const isError = (result.status ?? 1) !== 0;
  return { text, isError };
}

const TOOLS = [
  {
    name: "hyperion_doctor",
    description:
      "Runs Hyperion's kit + cards-sync health check (read-only). Reports project.yml presence, memory template status, CI policy detection, GitHub token/Project/field/label health. May make real read-only GitHub API calls using the local gh CLI session or configured token. Never writes anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => runKitScript("doctor.mjs"),
  },
  {
    name: "hyperion_project_verify",
    description:
      "Validates .github/project.yml against project.schema.json (read-only): version, name, commands.test hint, and that apps/docs paths referenced in it actually exist on disk. No network calls, no writes.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Repo root to check (defaults to the current working directory)." },
      },
      additionalProperties: false,
    },
    run: (args) => runKitScript("project-verify.mjs", args?.root ? ["--root", String(args.root)] : []),
  },
];

function handleInitialize(id) {
  sendResult(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

function handleToolsList(id) {
  sendResult(
    id,
    {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }
  );
}

function handleToolsCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) {
    sendError(id, -32602, `Unknown tool: ${params?.name}`);
    return;
  }
  try {
    const { text, isError } = tool.run(params?.arguments || {});
    sendResult(id, { content: [{ type: "text", text }], isError });
  } catch (error) {
    sendResult(id, { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true });
  }
}

function handleMessage(message) {
  const { id, method, params } = message;
  const hasId = id !== undefined && id !== null;

  switch (method) {
    case "initialize":
      handleInitialize(id);
      return;
    case "notifications/initialized":
      // Notification — no response expected.
      return;
    case "ping":
      if (hasId) sendResult(id, {});
      return;
    case "tools/list":
      handleToolsList(id);
      return;
    case "tools/call":
      handleToolsCall(id, params);
      return;
    default:
      if (hasId) sendError(id, -32601, `Method not found: ${method}`);
      // Unknown notification (no id) — silently ignore, per JSON-RPC spec.
  }
}

function main() {
  logErr(`Hyperion MCP server starting (tools: ${TOOLS.map((t) => t.name).join(", ")})`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      logErr(`Failed to parse message: ${error.message}`);
      return;
    }
    try {
      handleMessage(message);
    } catch (error) {
      logErr(`Handler error: ${error.message}`);
      if (message?.id !== undefined && message?.id !== null) {
        sendError(message.id, -32603, `Internal error: ${error.message}`);
      }
    }
  });

  rl.on("close", () => {
    logErr("stdin closed — exiting");
    process.exit(0);
  });
}

main();
