#!/usr/bin/env node
/**
 * Verify .github/project.yml is present, minimally valid, and referenced paths exist.
 * Run: npm run hyperion:project-verify
 *      npm run hyperion:project-verify -- --root .
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectCommands } from "./repo-detect.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Real JSON-Schema validation against project.schema.json — structural/type
 * checks (unknown keys, wrong types, bad enums) that the hand-rolled
 * regex extraction below can't catch, since it only reads the handful of
 * fields it knows to look for.
 *
 * ajv/js-yaml are dynamically imported (not top-level) so a missing
 * `npm install` produces one clear, actionable line here instead of a raw
 * `ERR_MODULE_NOT_FOUND` stack trace crashing the whole process before any
 * of our own error handling can run.
 */
async function validateAgainstSchema(root, text) {
  const schemaPath = join(root, ".github", "project.schema.json");
  if (!existsSync(schemaPath)) {
    return { ok: true, skipped: true, errors: [] };
  }
  let Ajv2020, loadYaml;
  try {
    Ajv2020 = (await import("ajv/dist/2020.js")).default;
    loadYaml = (await import("js-yaml")).load;
  } catch {
    return {
      ok: false,
      skipped: false,
      errors: [
        'dependencies not installed — run "npm install" in the kit folder first (ajv + js-yaml are required for schema validation)',
      ],
    };
  }
  let data;
  try {
    data = loadYaml(text);
  } catch (err) {
    return { ok: false, skipped: false, errors: [`YAML parse error: ${err.message}`] };
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (valid) return { ok: true, skipped: false, errors: [] };
  const errors = (validate.errors || []).map(
    (e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`
  );
  return { ok: false, skipped: false, errors };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

function usage() {
  console.log(`Usage:
  npm run hyperion:project-verify
  npm run hyperion:project-verify -- --root <repo-root>

Checks project.yml: version, name, commands.test hint, apps/docs paths exist.
`);
}

function pathExists(root, rel) {
  if (!rel || rel === "null" || rel === "~") return true;
  const abs = join(root, rel.replace(/^\.\//, ""));
  return existsSync(abs);
}

function extractTopKey(text, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** Collect apps.<id>.root and apps.<id>.manifest paths from simple YAML. */
function extractAppPaths(text) {
  const paths = [];
  const lines = text.split(/\r?\n/);
  let inApps = false;
  let currentApp = null;
  for (const line of lines) {
    if (/^apps:\s*$/.test(line)) {
      inApps = true;
      currentApp = null;
      continue;
    }
    if (inApps && /^[a-zA-Z_]/.test(line) && !/^\s/.test(line)) {
      inApps = false;
      currentApp = null;
    }
    if (!inApps) continue;
    const appHeader = line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*$/);
    if (appHeader) {
      currentApp = appHeader[1];
      continue;
    }
    if (!currentApp) continue;
    const rootM = line.match(/^\s{4}root:\s*(.+)$/);
    if (rootM) paths.push({ kind: `apps.${currentApp}.root`, rel: rootM[1].trim().replace(/^["']|["']$/g, "") });
    const manM = line.match(/^\s{4}manifest:\s*(.+)$/);
    if (manM) paths.push({ kind: `apps.${currentApp}.manifest`, rel: manM[1].trim().replace(/^["']|["']$/g, "") });
    const srcM = line.match(/^\s{6}-\s+(.+)$/);
    // source_dirs list items — only if previous context was source_dirs; heuristic: indented list under apps
    if (srcM && /source_dirs:/.test(lines[lines.indexOf(line) - 1] || "")) {
      paths.push({ kind: `apps.${currentApp}.source_dirs`, rel: srcM[1].trim().replace(/^["']|["']$/g, "") });
    }
  }
  // Second pass for source_dirs blocks
  let app = null;
  let inSource = false;
  inApps = false;
  for (const line of lines) {
    if (/^apps:\s*$/.test(line)) {
      inApps = true;
      continue;
    }
    if (inApps && /^[a-zA-Z_]/.test(line) && !/^\s/.test(line)) {
      inApps = false;
      inSource = false;
    }
    if (!inApps) continue;
    const appHeader = line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*$/);
    if (appHeader) {
      app = appHeader[1];
      inSource = false;
      continue;
    }
    if (/^\s{4}source_dirs:\s*$/.test(line)) {
      inSource = true;
      continue;
    }
    if (inSource && /^\s{4}\w+:/.test(line)) {
      inSource = false;
    }
    if (inSource && app) {
      const item = line.match(/^\s{6}-\s+(.+)$/);
      if (item) {
        paths.push({
          kind: `apps.${app}.source_dirs`,
          rel: item[1].trim().replace(/^["']|["']$/g, ""),
        });
      }
    }
  }
  return paths;
}

function extractDocsPaths(text) {
  const block = text.match(/^docs:\s*\n([\s\S]*?)(?=\n[a-zA-Z_]|\n*$)/m);
  if (!block) return [];
  const out = [];
  for (const line of block[1].split(/\r?\n/)) {
    const m = line.match(/^\s{2}(\w+):\s*(.+)$/);
    if (!m) continue;
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!val || val === "null" || val === "~") continue;
    out.push({ kind: `docs.${m[1]}`, rel: val });
  }
  return out;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    process.exit(0);
  }

  const root = resolve(argValue("--root") || process.cwd());
  const ymlPath = join(root, ".github", "project.yml");
  if (!existsSync(ymlPath)) {
    console.error("FAIL: missing .github/project.yml — run /discover Configure or /migrate");
    process.exit(1);
  }

  const text = readFileSync(ymlPath, "utf8");
  let failed = 0;
  const warnings = [];

  const schemaResult = await validateAgainstSchema(root, text);
  if (schemaResult.skipped) {
    warnings.push("no .github/project.schema.json found — skipping JSON-Schema validation");
  } else if (!schemaResult.ok) {
    for (const e of schemaResult.errors) {
      console.error(`FAIL schema: ${e}`);
      failed++;
    }
  } else {
    console.log("OK schema: project.yml matches project.schema.json");
  }

  const version = extractTopKey(text, "version");
  if (!version || !/^\d+$/.test(version)) {
    console.error("FAIL: project.yml must have integer `version:`");
    failed++;
  } else {
    console.log(`OK version: ${version}`);
  }

  const name = extractTopKey(text, "name");
  if (!name) {
    console.error("FAIL: project.yml must have `name:`");
    failed++;
  } else {
    console.log(`OK name: ${name}`);
  }

  const cmds = readProjectCommands(text);
  if (!cmds.test) {
    warnings.push("no commands.test — /execute and /pr-review will struggle");
  } else {
    console.log(`OK commands.test: ${cmds.test}`);
  }

  if (!/^uncertainties:/m.test(text) && !/uncertainties:\s*\[/m.test(text)) {
    warnings.push("no uncertainties: — Configure mode should list unknowns for the user");
  }

  for (const { kind, rel } of [...extractAppPaths(text), ...extractDocsPaths(text)]) {
    if (!pathExists(root, rel)) {
      console.error(`FAIL ${kind}: path missing → ${rel}`);
      failed++;
    } else {
      try {
        const st = statSync(join(root, rel.replace(/^\.\//, "")));
        console.log(`OK ${kind}: ${rel}${st.isDirectory() ? "/" : ""}`);
      } catch {
        console.log(`OK ${kind}: ${rel}`);
      }
    }
  }

  for (const w of warnings) console.warn(`WARN: ${w}`);

  if (failed) {
    console.error(`\nproject-verify FAILED (${failed})`);
    process.exit(1);
  }
  console.log("project-verify OK");
}

main().catch((err) => {
  console.error(`FAIL: unexpected error — ${err.message}`);
  process.exit(1);
});
