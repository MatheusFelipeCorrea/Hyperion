import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");

/** Spawns the real server, sends `messages` (each auto-newline-terminated),
 * and resolves once `expectedResponses` JSON-RPC lines have been read from
 * stdout (or after `timeoutMs`, whichever comes first). Integration-style
 * on purpose — this protocol dispatch is worth testing end-to-end, not
 * just as isolated pure functions, since a shape regression here silently
 * breaks every MCP client rather than throwing. */
function runServer(messages, expectedResponses, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(responses);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          responses.push(JSON.parse(line));
        } catch (error) {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`Non-JSON line from server: ${line} (${error.message})`));
          return;
        }
        if (responses.length >= expectedResponses) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
        }
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

test("initialize returns protocolVersion, tools capability, and serverInfo", async () => {
  const responses = await runServer([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }], 1);
  assert.equal(responses.length, 1);
  const res = responses[0];
  assert.equal(res.id, 1);
  assert.equal(typeof res.result.protocolVersion, "string");
  assert.ok(res.result.capabilities.tools);
  assert.equal(res.result.serverInfo.name, "hyperion");
});

test("a notification (no id) gets no response at all", async () => {
  const responses = await runServer(
    [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 99, method: "ping" },
    ],
    1
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 99);
});

test("tools/list returns hyperion_doctor and hyperion_project_verify with input schemas", async () => {
  const responses = await runServer([{ jsonrpc: "2.0", id: 2, method: "tools/list" }], 1);
  const tools = responses[0].result.tools;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("hyperion_doctor"));
  assert.ok(names.includes("hyperion_project_verify"));
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("tools/call on an unknown tool returns a JSON-RPC error, not a crash", async () => {
  const responses = await runServer(
    [{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "not_a_real_tool", arguments: {} } }],
    1
  );
  assert.equal(responses[0].id, 3);
  assert.equal(responses[0].error.code, -32602);
});

test("an unknown method with an id gets a method-not-found error", async () => {
  const responses = await runServer([{ jsonrpc: "2.0", id: 4, method: "totally/unknown" }], 1);
  assert.equal(responses[0].error.code, -32601);
});

test("tools/call hyperion_project_verify runs the real script and returns text content", async () => {
  const responses = await runServer(
    [{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "hyperion_project_verify", arguments: {} } }],
    1
  );
  const result = responses[0].result;
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /project-verify/i);
  assert.equal(typeof result.isError, "boolean");
});
