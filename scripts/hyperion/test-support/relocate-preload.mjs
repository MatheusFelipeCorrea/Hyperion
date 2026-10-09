/**
 * Test support: make ONE kit script believe it lives somewhere else (a temp dir),
 * so roots it derives from `import.meta.url` resolve there, while V8 coverage still
 * attributes execution to the real file. The rewrite keeps the source length
 * identical (`import.meta.url` → `globalThis.__RU`, 15 chars each), so coverage
 * offsets stay exact.
 *
 *   node --import <file-url of this> <real script> ...
 *   HYPERION_RELOCATE_FROM  absolute path of the real script
 *   HYPERION_RELOCATE_TO    absolute path the script should see as its own location
 *
 * Also usable through NODE_OPTIONS so a parent CLI's child process gets relocated.
 */
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const from = process.env.HYPERION_RELOCATE_FROM;
const to = process.env.HYPERION_RELOCATE_TO;
// Also evaluated in the hooks thread, where load() below compares against it.
const fromUrl = pathToFileURL(String(from)).href;

if (isMainThread && from && to) {
  globalThis.__RU = pathToFileURL(to).href;
  if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(from)) process.argv[1] = to;
  register(import.meta.url);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== fromUrl || result.source == null) return result;
  return { ...result, source: String(result.source).replaceAll("import.meta.url", "globalThis.__RU") };
}
