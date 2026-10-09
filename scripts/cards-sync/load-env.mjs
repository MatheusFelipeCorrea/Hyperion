/**
 * Loads `.env.local`, then `.env`, from the working directory into process.env,
 * never overriding a variable that is already set. Lets a contributor point the
 * cards scripts at their own board (PROJECT_NUMBER, PROJECT_OWNER,
 * PROJECT_SYNC_TOKEN) with nothing committed — both files are gitignored.
 *
 * Import it first in an entry script: `import "./load-env.mjs";`
 * Skipped in CI, under `node --test`, and with HYPERION_NO_DOTENV=1.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const ENV_FILES = [".env.local", ".env"];

export function loadLocalEnv(root = process.cwd(), env = process.env) {
  const loaded = [];
  for (const name of ENV_FILES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
      if (env[key] !== undefined) continue;
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

const skip =
  String(process.env.CI || "").toLowerCase() === "true" ||
  process.env.NODE_TEST_CONTEXT ||
  process.env.HYPERION_NO_DOTENV === "1";

if (!skip) loadLocalEnv();
