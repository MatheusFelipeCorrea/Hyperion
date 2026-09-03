#!/usr/bin/env node
/**
 * Verify a release agent run left a consistent artifact: CHANGELOG.md has a
 * dated section for the current package version, with content under it.
 * Run: npm run hyperion:release-verify
 *      npm run hyperion:release-verify -- --root <repo-root>
 *      npm run hyperion:release-verify -- --root <repo-root> --version 1.2.0
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordEvent } from "./telemetry-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(__dirname, "../..");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

function usage() {
  console.log(`Usage:
  npm run hyperion:release-verify -- --root <repo-root>
  npm run hyperion:release-verify -- --root <repo-root> --version <X.Y.Z>
  npm run hyperion:release-verify -- --changelog <path> --version <X.Y.Z>

Checks CHANGELOG.md has a "## [<version>]" section (matching package.json's
"version" unless --version overrides it) with non-empty content under it.
`);
}

function readPackageVersion(rootDir) {
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    process.exit(0);
  }

  const rootDir = resolve(argValue("--root") || defaultRoot);
  const changelogPath = resolve(argValue("--changelog") || join(rootDir, "CHANGELOG.md"));

  if (!existsSync(changelogPath)) {
    console.error(`FAIL: CHANGELOG not found at ${changelogPath}`);
    process.exit(1);
  }

  let version = argValue("--version");
  if (!version) version = readPackageVersion(rootDir);
  if (!version) {
    console.error("FAIL: no --version given and no version found in package.json");
    usage();
    process.exit(1);
  }

  const text = readFileSync(changelogPath, "utf8");
  let failed = 0;

  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // No "m" flag: with it, "$" would match end-of-line instead of end-of-string,
  // truncating the capture at the version heading's own line.
  // [^\n]* consumes the rest of the heading line first (e.g. a Keep-a-Changelog
  // date suffix: "## [1.2.0] — 2026-09-01") so it can't be mistaken for real
  // release-note content — the capture group only starts on the next line.
  const headingRe = new RegExp(`(?:^|\\n)##\\s*\\[${escaped}\\][^\\n]*\\n?([\\s\\S]*?)(?=\\n##\\s|$)`);
  const match = text.match(headingRe);

  if (!match) {
    console.error(`FAIL: CHANGELOG.md has no "## [${version}]" section for the current version`);
    failed++;
  } else {
    console.log(`OK: CHANGELOG.md has a section for [${version}]`);
    const body = match[1].trim();
    if (!body) {
      console.error(`FAIL: [${version}] section in CHANGELOG.md is empty`);
      failed++;
    } else {
      console.log("OK: version section has content");
    }
  }

  const unreleasedRe = /(?:^|\n)##\s*\[Unreleased\]([\s\S]*?)(?=\n##\s|$)/i;
  if (unreleasedRe.test(text)) {
    const unreleased = text.match(unreleasedRe)?.[1] || "";
    if (unreleased.trim() && /###\s+\w+[\s\S]*?-\s+\S/.test(unreleased)) {
      console.warn(
        "WARN: [Unreleased] section still has entries — confirm they belong in a later release, not this one"
      );
    }
  }

  if (failed) {
    console.error(`\nrelease-verify FAILED (${failed})`);
    process.exit(1);
  }
  recordEvent(rootDir, "agent-gate", "release-verify");
  console.log("release-verify OK");
}

main();
