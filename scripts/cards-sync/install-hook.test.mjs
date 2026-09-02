import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPreCommitHookBody } from "./install-hook.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

test("buildPreCommitHookBody uses nested kit paths", () => {
  const root = mkdtempSync(join(tmpdir(), "hyperion-hook-"));
  mkdirSync(join(root, ".github"), { recursive: true });
  mkdirSync(join(root, "Hyperion", ".github", "cards"), { recursive: true });
  writeFileSync(
    join(root, ".github", "project.yml"),
    "kit:\n  root: Hyperion\n",
    "utf8"
  );

  const paths = resolveHyperionPaths(root);
  const body = buildPreCommitHookBody(paths);

  assert.ok(body.includes("Hyperion/scripts/cards-sync/validate.mjs"));
  assert.ok(body.includes("Hyperion/.github/cards") || body.includes("Hyperion/\\.github/cards"));
  assert.match(body, /hyperion-cards-validate/);
  assert.match(body, /hyperion-check-rules/);
});

test("buildPreCommitHookBody uses legacy root layout", () => {
  const root = mkdtempSync(join(tmpdir(), "hyperion-hook-"));
  mkdirSync(join(root, ".github", "cards"), { recursive: true });

  const paths = resolveHyperionPaths(root);
  const body = buildPreCommitHookBody(paths);

  assert.match(body, /\.github\/cards/);
  assert.match(body, /scripts\/cards-sync\/validate\.mjs/);
  assert.doesNotMatch(body, /Hyperion\/scripts/);
});
