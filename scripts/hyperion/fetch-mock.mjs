/**
 * Test support: run a kit entry script as a subprocess with fetch replaced by a
 * route module (see fetch-mock-preload.mjs). Code executed in the subprocess still
 * counts toward `node --test --experimental-test-coverage`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const preload = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "fetch-mock-preload.mjs")).href;

/**
 * @param {string} script absolute path of the entry script
 * @param {string[]} args
 * @param {{ cwd: string, route?: string, state?: object, env?: Record<string, string|undefined>, input?: string }} opts
 *   route: absolute path of a module exporting `default (req, state) => ...`
 * @returns {{ status: number|null, stdout: string, stderr: string, calls: object[], state: object }}
 */
export function runWithFetchMock(script, args = [], { cwd, route, state, env = {}, input } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-fetch-"));
  const logPath = join(dir, "calls.json");
  const statePath = join(dir, "state.json");
  if (state) writeFileSync(statePath, JSON.stringify(state));
  try {
    const childEnv = {
      ...process.env,
      HYPERION_NO_DOTENV: "1",
      GITHUB_ACTIONS: "",
      ...env,
      ...(route ? { HYPERION_FETCH_MOCK: route, HYPERION_FETCH_LOG: logPath, HYPERION_FETCH_STATE: statePath } : {}),
    };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    const result = spawnSync(process.execPath, ["--import", preload, script, ...args], {
      cwd,
      env: childEnv,
      encoding: "utf8",
      input,
      timeout: 60_000,
    });
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      calls: existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [],
      state: existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {},
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
