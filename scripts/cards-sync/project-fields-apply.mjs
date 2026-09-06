#!/usr/bin/env node
/**
 * Creates or renames the 8 GitHub Project fields Hyperion expects, on an
 * EXISTING Project — without recreating it.
 *
 * `doctor.mjs` can only detect that fields are missing/misnamed on an
 * existing Project; its own advice today is "create them manually" or
 * "let sync auto-create a brand-new Project" (which only helps for a
 * project that doesn't exist yet, not for fixing one that already does).
 * This script closes that gap by reusing sync.mjs's own field-creation
 * helpers — the same ones it uses when auto-creating a fresh Project —
 * against a Project you already have.
 *
 * Dry-run by default, same convention as labels-reset.mjs: pass --yes to
 * actually write to the board.
 *
 * Usage:
 *   npm run cards:project-fields-apply           # preview only
 *   npm run cards:project-fields-apply -- --yes   # apply
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  detectRepoFromGit,
  detectTokenFromGhCli,
  readJsonIfExists,
  resolveRepoConfig,
} from "./lib.mjs";
import {
  graphql,
  getProject,
  getFieldByName,
  addSingleSelectField,
  addTextField,
  addNumberField,
  addDateField,
  addIterationField,
  REQUIRED_FIELDS,
} from "./sync.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";

const hyperionPaths = resolveHyperionPaths(process.cwd());
const cardsRoot = hyperionPaths.cardsRoot;
const configPath = path.join(cardsRoot, "config", "projects-map.json");

const argYes = process.argv.includes("--yes");
const dryRun = !argYes;

function log(msg) {
  console.log(`[project-fields-apply] ${msg}`);
}

/** Same aliases doctor.mjs checks against — matching an existing field under
 * a legacy/localized name should count as "present", not "missing". */
const FIELD_NAME_ALIASES = {
  status: ["Status"],
  type: ["Type", "Tipo"],
  priority: ["Priority", "Prioridade"],
  sprint: ["Sprint", "Numero da Sprint", "Número da Sprint"],
  storyPoints: ["Story Points"],
  reporter: ["Reporter", "Relator"],
  parent: ["Parent (Epic/Feature)", "Pai (Epic/Feature)"],
  dueDate: ["Due Date", "Data Limite"],
};

function findFieldByAliases(project, canonicalName, key) {
  const candidates = [canonicalName, ...(FIELD_NAME_ALIASES[key] || [])];
  for (const candidate of candidates) {
    const found = getFieldByName(project, candidate);
    if (found) return found;
  }
  return null;
}

async function renameField(fieldId, newName) {
  await graphql(
    `mutation($fieldId: ID!, $name: String!) {
      updateProjectV2Field(input: { fieldId: $fieldId, name: $name }) {
        projectV2Field { ... on ProjectV2Field { id name } }
      }
    }`,
    { fieldId, name: newName }
  );
}

async function createField(project, key, name, repoConfig) {
  const spec = REQUIRED_FIELDS.find((f) => f.key === key);
  if (!spec) throw new Error(`No creation spec for field key "${key}"`);

  if (spec.kind === "single_select") {
    await addSingleSelectField(project.id, name, spec.options, spec.key);
  } else if (spec.kind === "number") {
    await addNumberField(project.id, name);
  } else if (spec.kind === "text") {
    await addTextField(project.id, name);
  } else if (spec.kind === "date") {
    await addDateField(project.id, name);
  } else if (spec.kind === "iteration") {
    await addIterationField(project.id, name, repoConfig);
  }
}

async function main() {
  if (dryRun) log("Dry-run mode (pass --yes to apply). Preview only.");

  const repositorySlug = process.env.GITHUB_REPOSITORY || detectRepoFromGit();
  if (!repositorySlug) {
    log("ERROR: cannot detect repository from git remote.");
    process.exit(1);
  }

  const token = process.env.PROJECT_SYNC_TOKEN || process.env.GITHUB_TOKEN || detectTokenFromGhCli();
  if (!token) {
    log("ERROR: no GitHub token. Run: gh auth login");
    process.exit(1);
  }

  const config = (await readJsonIfExists(configPath)) || { default: {} };
  const repoConfig = resolveRepoConfig(config, repositorySlug);

  const [owner] = repositorySlug.split("/");
  const projectOwner = repoConfig.projectOwner || owner;
  const projectNumber = Number(repoConfig.projectNumber || 0);

  if (!projectNumber) {
    log("ERROR: projects-map.json has no projectNumber configured for this repo.");
    log("This command fixes fields on an EXISTING Project — it doesn't create one.");
    log("Run `npm run cards:sync` (or `npm run cards:doctor`) first to auto-create a Project.");
    process.exit(1);
  }

  log(`Repository: ${repositorySlug}`);
  log(`Project: owner=${projectOwner} number=${projectNumber}`);

  const project = await getProject(projectOwner, projectNumber);
  if (!project) {
    log(`ERROR: Project #${projectNumber} not found for owner "${projectOwner}".`);
    process.exit(1);
  }

  const fieldMap = repoConfig.fieldMap || {};
  // Status is handled read-only here: GitHub auto-creates it on every new
  // Project, so a full "create from scratch" path isn't needed — only rename.
  const targets = [
    { key: "status", canonicalName: fieldMap.status || "Status", creatable: false },
    ...REQUIRED_FIELDS.map((spec) => ({
      key: spec.key,
      canonicalName: fieldMap[spec.key] || spec.defaultName,
      creatable: true,
    })),
  ];

  let created = 0;
  let renamed = 0;
  let ok = 0;

  for (const target of targets) {
    const found = findFieldByAliases(project, target.canonicalName, target.key);

    if (!found) {
      if (!target.creatable) {
        log(`  MISSING: ${target.canonicalName} (no Status field found — Project may be misconfigured; not auto-creatable here)`);
        continue;
      }
      if (dryRun) {
        log(`  (dry-run) create: ${target.canonicalName}`);
      } else {
        await createField(project, target.key, target.canonicalName, repoConfig);
        log(`  + created: ${target.canonicalName}`);
      }
      created += 1;
      continue;
    }

    if (found.name !== target.canonicalName) {
      if (dryRun) {
        log(`  (dry-run) rename: "${found.name}" -> "${target.canonicalName}"`);
      } else {
        await renameField(found.id, target.canonicalName);
        log(`  ~ renamed: "${found.name}" -> "${target.canonicalName}"`);
      }
      renamed += 1;
      continue;
    }

    ok += 1;
  }

  log("");
  log(`OK: ${ok} | Created: ${created} | Renamed: ${renamed}`);
  if (dryRun && (created || renamed)) {
    log("Dry-run complete. Re-run with --yes to apply.");
  }
}

main().catch((error) => {
  console.error("[project-fields-apply] FATAL:", error.message);
  process.exit(1);
});
