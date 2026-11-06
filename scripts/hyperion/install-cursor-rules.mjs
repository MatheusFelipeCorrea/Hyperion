/**
 * Copy the kit's Cursor rules (<kit>/.cursor/rules/hyperion.mdc, found from this
 * script's own location) into the repo it runs in (cwd). Idempotent: an identical
 * target is left alone.
 *
 * A kit nested under the cwd (your-product/Hyperion/) is not installed at the product
 * root: its rules point at root-level .github/ paths, so the product gets the pointer
 * shim from install-product-shims.mjs (`hyperion:init -- --adopt`) instead.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { log, ok, warn, workspaceRoot } from "./lib.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rulesRel = path.join(".cursor", "rules", "hyperion.mdc");
const sourcePath = path.join(kitRoot, rulesRel);
const targetPath = path.join(workspaceRoot, rulesRel);

/** Kit folder relative to the cwd when the kit lives inside it (nested layout), else null. */
function nestedKitDir() {
  const rel = path.relative(workspaceRoot, kitRoot);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
}

async function main() {
  log("", "Hyperion Cursor rules install");
  const nested = nestedKitDir();
  if (nested) {
    ok(`Nested kit (${nested}/): product rules come from the shim — npm run hyperion:init --prefix ${nested} -- --adopt`);
    return;
  }

  const content = await fs.readFile(sourcePath, "utf8").catch(() => null);
  if (content === null) {
    warn(`No hyperion.mdc template found in the kit: ${sourcePath}`);
    process.exit(1);
  }

  const existing = await fs.readFile(targetPath, "utf8").catch(() => null);
  if (existing === content) {
    ok("Cursor rules already up to date: .cursor/rules/hyperion.mdc");
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
  ok(`${existing === null ? "Installed" : "Updated"} .cursor/rules/hyperion.mdc`);
}

main().catch((error) => {
  console.error("[Hyperion] FATAL:", error.message);
  process.exit(1);
});
