import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");

/** Spawns the real server, sends `messages` (objects are JSON-encoded, strings
 * are written verbatim; each line auto-newline-terminated), waits until
 * `expectedResponses` JSON-RPC lines have been read from stdout, then closes
 * stdin so the server shuts down on its own. Integration-style on purpose —
 * this protocol dispatch is worth testing end-to-end, not just as isolated
 * pure functions, since a shape regression here silently breaks every MCP
 * client rather than throwing. Resolves { responses, code, stderr }. */
function runServer(messages, expectedResponses, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buffer = "";
    let stderr = "";
    let closing = false;
    const closeStdin = () => {
      if (closing) return;
      closing = true;
      child.stdin.end();
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server timed out with ${responses.length}/${expectedResponses} responses; stderr:\n${stderr}`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
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
        if (responses.length >= expectedResponses) closeStdin();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ responses, code, stderr });
    });

    for (const message of messages) {
      child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    }
    if (expectedResponses === 0) closeStdin();
  });
}

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("initialize returns protocolVersion, tools capability, and serverInfo", async () => {
  const { responses, code, stderr } = await runServer([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }], 1);
  assert.equal(responses.length, 1);
  const res = responses[0];
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.deepEqual(res.result.serverInfo, { name: "hyperion", version: "0.2.0" });
  assert.equal(code, 0);
  assert.match(stderr, /starting \(tools: hyperion_doctor, hyperion_project_verify\)/);
  assert.match(stderr, /stdin closed — exiting/);
});

test("a notification (no id) gets no response at all", async () => {
  const { responses } = await runServer(
    [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/unknown" },
      { jsonrpc: "2.0", id: null, method: "totally/unknown" },
      { jsonrpc: "2.0", id: 99, method: "ping" },
    ],
    1
  );
  assert.deepEqual(responses, [{ jsonrpc: "2.0", id: 99, result: {} }]);
});

test("tools/list returns hyperion_doctor and hyperion_project_verify with input schemas", async () => {
  const { responses } = await runServer([{ jsonrpc: "2.0", id: 2, method: "tools/list" }], 1);
  const tools = responses[0].result.tools;
  assert.deepEqual(tools.map((t) => t.name), ["hyperion_doctor", "hyperion_project_verify"]);
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.run, undefined);
  }
  assert.equal(tools[1].inputSchema.properties.root.type, "string");
});

test("tools/call on an unknown or missing tool returns a JSON-RPC error, not a crash", async () => {
  const { responses } = await runServer(
    [
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "not_a_real_tool", arguments: {} } },
      { jsonrpc: "2.0", id: 31, method: "tools/call" },
    ],
    2
  );
  assert.deepEqual(responses[0], { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Unknown tool: not_a_real_tool" } });
  assert.deepEqual(responses[1].error, { code: -32602, message: "Unknown tool: undefined" });
});

test("an unknown method with an id gets a method-not-found error", async () => {
  const { responses } = await runServer([{ jsonrpc: "2.0", id: 4, method: "totally/unknown" }], 1);
  assert.deepEqual(responses[0].error, { code: -32601, message: "Method not found: totally/unknown" });
});

test("blank lines and unparseable JSON are logged to stderr and skipped", async () => {
  const { responses, stderr } = await runServer(["", "   ", "{not json", { jsonrpc: "2.0", id: 6, method: "ping" }], 1);
  assert.deepEqual(responses, [{ jsonrpc: "2.0", id: 6, result: {} }]);
  assert.match(stderr, /Failed to parse message: /);
});

test("a handler crash becomes -32603 for requests and is only logged for id-less messages", async () => {
  const { responses, stderr } = await runServer(
    [
      "null",
      // `${method}` can't stringify an object whose toString isn't callable.
      { jsonrpc: "2.0", id: 7, method: { toString: 1 } },
      { jsonrpc: "2.0", id: 8, method: "ping" },
    ],
    2
  );
  assert.equal(responses[0].id, 7);
  assert.equal(responses[0].error.code, -32603);
  assert.match(responses[0].error.message, /^Internal error: /);
  assert.deepEqual(responses[1], { jsonrpc: "2.0", id: 8, result: {} });
  assert.equal((stderr.match(/Handler error: /g) || []).length, 2);
});

test("tools/call hyperion_project_verify runs the real script against the given root", async () => {
  const ok = mkdtempSync(path.join(tmpdir(), "hyperion-mcp-ok-"));
  const missing = mkdtempSync(path.join(tmpdir(), "hyperion-mcp-missing-"));
  tempDirs.push(ok, missing);
  mkdirSync(path.join(ok, ".github"), { recursive: true });
  writeFileSync(
    path.join(ok, ".github", "project.yml"),
    "version: 1\nname: Demo\nlocale: en\ncommands:\n  test: npm test\nuncertainties: []\n"
  );

  const { responses } = await runServer(
    [
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "hyperion_project_verify", arguments: { root: ok } } },
      { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "hyperion_project_verify", arguments: { root: missing } } },
    ],
    2
  );
  assert.equal(responses[0].id, 5);
  assert.equal(responses[0].result.content[0].type, "text");
  assert.match(responses[0].result.content[0].text, /project-verify OK/);
  assert.equal(responses[0].result.isError, false);
  assert.match(responses[1].result.content[0].text, /FAIL: missing \.github\/project\.yml/);
  assert.equal(responses[1].result.isError, true);
});

test("a tool that throws is reported as an isError result, not a protocol error", async () => {
  const { responses } = await runServer(
    [
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "hyperion_project_verify", arguments: { root: "bad\u0000root" } },
      },
    ],
    1
  );
  assert.equal(responses[0].id, 9);
  assert.equal(responses[0].result.isError, true);
  assert.match(responses[0].result.content[0].text, /^Error: /);
});
