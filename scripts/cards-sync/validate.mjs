import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { listCardsMarkdownFiles, checkCardPathLayout, parseFrontmatter, parseProjectYmlBackend } from "./lib.mjs";
import { resolveHyperionPaths } from "../hyperion/paths.mjs";
import { ciFailList } from "../hyperion/ci-annotate.mjs";

const paths = resolveHyperionPaths(process.cwd());
const workspaceRoot = paths.workspaceRoot;
const cardsRoot = paths.cardsRoot;
const cardsPrefix = paths.cardsPrefix;
const projectYmlPath = paths.projectYmlPath;
const strictLayout = process.argv.includes("--strict-layout");
const warnings = [];

const ALLOWED_TYPES = new Set(["Epic", "Feature", "Story", "Task", "Subtask", "Bug"]);
const ALLOWED_PRIORITIES = new Set(["Highest", "High", "Medium", "Low"]);
const ALLOWED_STATUS = new Set([
  "Backlog",
  "Functional Refinement",
  "Technical Refinement",
  "In Progress",
  "In Tests",
  "In Revision",
  "Done",
]);

/**
 * Returns { card, reason }. `card` is null when the file can't be parsed as
 * a card at all — the caller must surface `reason` loudly (not just skip),
 * since a silently-dropped card also silently never syncs.
 */
function extractCard(content, relativeFile) {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return { card: null, reason: "malformed frontmatter — expected a `---`-delimited YAML block at the top of the file" };
  }
  if (!parsed.meta?.card_id) {
    return { card: null, reason: "missing required `card_id` in frontmatter" };
  }

  const meta = parsed.meta;
  return {
    card: {
      cardId: meta.card_id,
      status: meta.status || null,
      type: meta.type || "Story",
      priority: meta.priority || null,
      sprint: meta.sprint || null,
      storyPoints: meta.story_points ?? null,
      reporter: meta.reporter || null,
      parent: meta.parent || null,
      dueDate: meta.due_date || null,
      categories: Array.isArray(meta.categories) ? meta.categories : [],
      relativeFile,
    },
    reason: null,
  };
}

function isValidDueDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const allMd = await listCardsMarkdownFiles(cardsRoot);
if (!allMd.length) {
  console.log(`[validate] No card files found under ${cardsPrefix}/`);
  process.exit(0);
}

// Lightweight config sanity checks (helps act as an "auto-refresh trigger")
try {
  const projectsMapPath = paths.projectsMapPath;

  const missing = [];
  try {
    await fs.stat(projectYmlPath);
  } catch {
    missing.push("`.github/project.yml`");
  }
  try {
    await fs.stat(projectsMapPath);
  } catch {
    missing.push(`\`${cardsPrefix}/config/projects-map.json\``);
  }

  if (missing.length) {
    console.log(`[validate] ⚠️  Missing config files: ${missing.join(", ")}`);
    console.log("[validate] Suggestion: run `project-discovery` in Configure mode, then re-run validate.");
  } else {
    const projectRaw = await fs.readFile(projectYmlPath, "utf8");
    const localeMatch = projectRaw.match(/^\s*locale\s*:\s*["']?([^\s#"']+)["']?\s*(?:#.*)?$/m);

    const locale = localeMatch?.[1];
    const backend = parseProjectYmlBackend(projectRaw);

    const SUPPORTED_BACKENDS = ["github", "jira", "azure-devops", "azure", "gitlab", "linear"];
    if (backend && !SUPPORTED_BACKENDS.includes(backend)) {
      console.log(`[validate] ⚠️  management.backend is set to "${backend}", which this kit doesn't recognize.`);
      console.log(`[validate] Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`);
    }

    if (locale) {
      console.log(`[validate] Locale detected in project.yml: ${locale}`);
    }
  }
} catch {
  // ignore
}

const errors = [];
const skipped = [];
const cards = [];
const cardIdSet = new Set();

for (const file of allMd) {
  const relative = path.relative(workspaceRoot, file).replace(/\\/g, "/");
  const raw = await fs.readFile(file, "utf8");
  const { card, reason } = extractCard(raw, relative);
  if (!card) {
    skipped.push(`${relative}: ${reason} — this file will NOT be validated or synced.`);
    continue;
  }

  cards.push(card);

  if (!card.cardId || typeof card.cardId !== "string") {
    errors.push(`${relative}: card_id is required (string).`);
  } else if (cardIdSet.has(card.cardId)) {
    errors.push(`${relative}: duplicate card_id "${card.cardId}".`);
  } else {
    cardIdSet.add(card.cardId);
  }

  if (!ALLOWED_TYPES.has(card.type)) {
    errors.push(`${relative}: type "${card.type}" is not allowed. Allowed: ${Array.from(ALLOWED_TYPES).join(", ")}.`);
  }

  if (card.priority !== null && card.priority !== undefined) {
    if (!ALLOWED_PRIORITIES.has(String(card.priority))) {
      errors.push(`${relative}: priority "${card.priority}" is not allowed. Allowed: ${Array.from(ALLOWED_PRIORITIES).join(", ")}.`);
    }
  }

  if (card.status !== null && card.status !== undefined) {
    if (typeof card.status !== "string") {
      errors.push(`${relative}: status must be a string (or null).`);
    } else if (!ALLOWED_STATUS.has(card.status)) {
      errors.push(
        `${relative}: status "${card.status}" is not allowed. Allowed: ${Array.from(ALLOWED_STATUS).join(", ")}.`
      );
    }
  }

  if (card.storyPoints !== null && card.storyPoints !== undefined) {
    if (typeof card.storyPoints !== "number" || !Number.isInteger(card.storyPoints)) {
      errors.push(`${relative}: story_points must be an integer number (or null).`);
    }
  }

  if (card.dueDate !== null && card.dueDate !== undefined && card.dueDate !== "") {
    if (!isValidDueDate(card.dueDate)) errors.push(`${relative}: due_date must be YYYY-MM-DD (or null).`);
  }

  if (card.parent !== null && card.parent !== undefined && card.parent !== "") {
    if (typeof card.parent !== "string") errors.push(`${relative}: parent must be a CARD_ID string or null.`);
  }

  // extractCard() already normalizes categories to an array, so no
  // Array.isArray check is needed here — only the element type matters.
  if (card.categories.some((c) => typeof c !== "string")) errors.push(`${relative}: categories must be an array of strings.`);

  // Nested-by-parent layout (warning by default; --strict-layout promotes to error)
  if (!relative.includes("/_examples/")) {
    const layout = checkCardPathLayout(relative, {
      type: card.type,
      cardId: card.cardId,
      parent: card.parent,
      cardsPrefix,
    });
    if (!layout.ok) {
      const hint = layout.legacyFlat
        ? `legacy flat path — prefer nested: ${layout.expected} (run npm run cards:migrate-layout)`
        : `expected path ${layout.expected} (parent folder = parent card_id)`;
      const msg = `${relative}: layout — ${hint}`;
      if (strictLayout) errors.push(msg);
      else warnings.push(msg);
    }
  }
}

const byId = new Map(cards.map((c) => [c.cardId, c]));
for (const card of cards) {
  if (card.parent && !byId.has(card.parent)) {
    errors.push(`${card.relativeFile}: parent "${card.parent}" not found among local card_ids.`);
  }
}

if (errors.length) {
  console.log("[validate] ❌ Cards validation failed:");
  for (const e of errors) console.log(`- ${e}`);
  ciFailList(workspaceRoot, "cards.fail.validate", errors);
  process.exit(1);
}

if (skipped.length) {
  // Loud on purpose: a card that never made it into `cards` also never
  // syncs, silently. Reported separately from layout warnings below since
  // it's a different class of problem (unparseable, not just misplaced).
  console.log(`[validate] ⚠️  ${skipped.length} file(s) skipped — could not be read as cards:`);
  for (const s of skipped) console.log(`- ${s}`);
}

if (warnings.length) {
  console.log("[validate] ⚠️  Layout warnings (use --strict-layout to fail):");
  for (const w of warnings) console.log(`- ${w}`);
}

console.log(`[validate] ✅ OK. Valid cards: ${cards.length}`);
