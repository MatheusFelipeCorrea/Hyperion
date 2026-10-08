/**
 * Bidirectional card reconcile (cards:auto): decide forward vs reverse vs field merge.
 *
 * Field ownership: the board owns status/sprint; git owns the spec (title, type,
 * priority, story points, reporter, parent, due date). A one-sided change flows
 * to the other side; same-field edits on both sides follow ownership and are
 * reported as conflicts.
 *
 * Ancestor: .github/plans/cards/last-state.json (snapshot of the last reconcile).
 * Without a snapshot, board fields only flow back when the issue is newer than
 * the last git commit of the card file.
 *
 * Never resurrects: a card known to the snapshot, tombstoned, or deleted in git
 * history is reported (deleted_locally) instead of recreated from its issue.
 * Closed issues without a local card are reported, not recreated.
 */

export const BOARD_FIELDS = ["status", "sprint"];
export const GIT_FIELDS = ["title", "type", "priority", "storyPoints", "reporter", "parent", "dueDate"];
export const MERGE_FIELDS = [...BOARD_FIELDS, ...GIT_FIELDS];

/** Frontmatter keys owned by the board in auto mode (board guard ignores their drift). */
export const BOARD_OWNED_FRONTMATTER = ["status", "sprint", "board_sync_at"];

export const DUPLICATE_MARKER = "hyperion-duplicate-of";

export function normalizeSyncScalar(value) {
  if (value === undefined || value === null || value === "" || value === "null") return null;
  return String(value).trim() || null;
}

export function scalarsEqual(left, right) {
  return normalizeSyncScalar(left) === normalizeSyncScalar(right);
}

export function isOpenIssueState(state) {
  const normalized = String(state || "").toUpperCase();
  return normalized === "OPEN" || normalized === "OPENED";
}

export function isRemoteNewer(local = {}, remote = {}) {
  const localMs = Date.parse(local.updatedAt || "");
  const remoteMs = Date.parse(remote.updatedAt || "");
  if (!Number.isFinite(localMs) || !Number.isFinite(remoteMs)) return false;
  return remoteMs > localMs;
}

/** Open issue first, then lowest number. Group must already share the same CARD_ID. */
export function pickCanonicalIssueFromGroup(issues = []) {
  const matches = (issues || []).filter((issue) => Number.isFinite(Number(issue?.number)));
  if (!matches.length) return null;
  return [...matches].sort((a, b) => {
    const openDelta = Number(isOpenIssueState(a.state)) - Number(isOpenIssueState(b.state));
    if (openDelta) return -openDelta;
    return Number(a.number) - Number(b.number);
  })[0];
}

export function snapshotFromCard(card = {}) {
  const snap = {};
  for (const field of MERGE_FIELDS) snap[field] = normalizeSyncScalar(card[field]);
  if (card.issueNumber != null) snap.issueNumber = Number(card.issueNumber);
  if (card.relativeFile) snap.sourceFile = String(card.relativeFile).replace(/\\/g, "/");
  return snap;
}

/**
 * @returns {{ field: string, gitChanged: boolean, boardChanged: boolean, local, remote, snapshot }[]}
 */
export function diffFields({ local = {}, remote = {}, snapshot = null } = {}) {
  const remoteNewer = isRemoteNewer(local, remote);
  return MERGE_FIELDS.map((field) => {
    const loc = local[field];
    const rem = remote[field];
    const snap = snapshot ? snapshot[field] : undefined;
    let gitChanged;
    let boardChanged;
    if (snapshot) {
      gitChanged = !scalarsEqual(loc, snap);
      boardChanged = !scalarsEqual(rem, snap);
    } else if (!scalarsEqual(loc, rem)) {
      gitChanged = GIT_FIELDS.includes(field);
      // No ancestor: only trust the board for its own fields, and only when the
      // issue changed after the last commit of the card file.
      boardChanged = BOARD_FIELDS.includes(field) && remoteNewer;
    } else {
      gitChanged = false;
      boardChanged = false;
    }
    return { field, gitChanged, boardChanged, local: loc, remote: rem, snapshot: snap };
  });
}

/**
 * @returns {'skip'|'forward'|'reverse'|'reverse_create'|'merge'|'deleted_locally'|'remote_only_closed'}
 */
export function classifyCard({ local = null, remote = null, snapshot = null, deletedLocally = false } = {}) {
  if (!local && remote) {
    if (snapshot || deletedLocally) return "deleted_locally";
    if (!isOpenIssueState(remote.state ?? remote.issue?.state)) return "remote_only_closed";
    return "reverse_create";
  }
  if (local && !remote) return "forward";
  if (!local && !remote) return "skip";

  const diffs = diffFields({ local, remote, snapshot });
  const gitChanged = diffs.filter((d) => d.gitChanged);
  const boardChanged = diffs.filter((d) => d.boardChanged);
  if (!gitChanged.length && !boardChanged.length) return "skip";
  if (gitChanged.length && boardChanged.length) return "merge";
  if (boardChanged.length) return "reverse";
  return "forward";
}

function ownerValue(field, loc, rem) {
  return BOARD_FIELDS.includes(field) ? rem : loc;
}

/**
 * Merge one card. Dual edits on the same field follow ownership
 * (board = status/sprint, git = the rest) instead of reverting both.
 */
export function mergeCardFields({ local = {}, remote = {}, snapshot = null } = {}) {
  const next = { ...local };
  const conflicts = [];
  const applied = [];

  for (const diff of diffFields({ local, remote, snapshot })) {
    const { field, gitChanged, boardChanged, local: loc, remote: rem } = diff;
    if (gitChanged && boardChanged && !scalarsEqual(loc, rem)) {
      const kept = ownerValue(field, loc, rem);
      const winner = BOARD_FIELDS.includes(field) ? "board" : "git";
      next[field] = kept;
      conflicts.push({ field, local: loc, remote: rem, kept, winner });
      applied.push({ field, from: winner, value: kept });
      continue;
    }
    if (boardChanged && !gitChanged) {
      next[field] = rem;
      applied.push({ field, from: "board", value: rem });
      continue;
    }
    if (gitChanged && !boardChanged) {
      next[field] = loc;
      applied.push({ field, from: "git", value: loc });
    }
  }

  return { next, conflicts, applied };
}

/** @param {Map<string, object[]>} grouped CARD_ID → every issue carrying it */
export function detectDuplicateIssues(grouped = new Map()) {
  const duplicates = [];
  for (const [cardId, issues] of grouped) {
    if (!Array.isArray(issues) || issues.length < 2) continue;
    const canonical = pickCanonicalIssueFromGroup(issues);
    const keep = Number(canonical?.number);
    const extraIssues = issues
      .filter((issue) => Number(issue.number) !== keep)
      .map((issue) => ({ number: Number(issue.number), id: issue.id || null, state: issue.state || null }))
      .sort((a, b) => a.number - b.number);
    duplicates.push({
      cardId,
      keep,
      extras: extraIssues.map((i) => i.number),
      extraIssues,
    });
  }
  return duplicates.sort((a, b) => a.cardId.localeCompare(b.cardId));
}

export function isPortugueseLocale(locale) {
  return /^pt\b/i.test(String(locale || ""));
}

/** Comment left once on each duplicate issue (marker makes it idempotent). */
export function duplicateCommentBody({ cardId, keep, locale = "en" }) {
  const marker = `<!-- ${DUPLICATE_MARKER}:#${keep} -->`;
  if (isPortugueseLocale(locale)) {
    return [
      marker,
      `Esta issue é uma **duplicata** de \`${cardId}\`.`,
      `A issue canônica é #${keep}. O sync do Hyperion ignora esta cópia — edite a canônica e feche esta quando puder.`,
    ].join("\n");
  }
  return [
    marker,
    `This issue is a **duplicate** of \`${cardId}\`.`,
    `The canonical issue is #${keep}. Hyperion sync ignores this copy — edit the canonical one and close this when convenient.`,
  ].join("\n");
}

export function parseLastSyncWhen(markdown) {
  const match = String(markdown || "").match(/\*\*When:\*\*\s*(\S+)/);
  if (!match) return null;
  return Number.isNaN(Date.parse(match[1])) ? null : match[1];
}

/** Snapshot keeps the previous state for cards whose forward push failed, so they retry. */
export function composeSnapshotCards(currentCards = [], previousSnapshot = null, failedIds = []) {
  const prev = previousSnapshot?.cards || {};
  const failed = new Set(failedIds);
  const cards = {};
  for (const card of currentCards) {
    if (!card?.cardId) continue;
    if (failed.has(card.cardId)) {
      if (prev[card.cardId]) cards[card.cardId] = prev[card.cardId];
      continue;
    }
    cards[card.cardId] = snapshotFromCard(card);
  }
  return cards;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** True when the snapshot content changed (ignores `when`), so scheduled runs don't commit noise. */
export function snapshotStateChanged(previous, next) {
  if (!previous) return true;
  const strip = (state) => ({ ...state, when: undefined });
  return stableStringify(strip(previous)) !== stableStringify(strip(next));
}

/** Tombstones survive across runs so a deleted card never comes back from its issue. */
export function composeTombstones(previousSnapshot = null, deletedIds = [], localIds = []) {
  const local = new Set(localIds);
  const all = new Set([...(previousSnapshot?.tombstones || []), ...deletedIds]);
  return [...all].filter((id) => !local.has(id)).sort();
}

/**
 * @param {{ localCards?: object[], remotes?: Map<string, object>, snapshot?: object|null, isDeletedInGit?: (cardId: string, remote: object) => boolean }} input
 */
export function buildReconcilePlan({ localCards = [], remotes = new Map(), snapshot = null, isDeletedInGit = () => false } = {}) {
  const snapCards = snapshot?.cards || {};
  const tombstones = new Set(snapshot?.tombstones || []);
  const localById = new Map(localCards.map((card) => [card.cardId, card]));
  const ids = [...new Set([...localById.keys(), ...remotes.keys()])].sort();
  const items = [];

  for (const cardId of ids) {
    const local = localById.get(cardId) || null;
    const remote = remotes.get(cardId) || null;
    const previous = snapCards[cardId] || null;
    const deletedLocally = !local && remote ? tombstones.has(cardId) || Boolean(isDeletedInGit(cardId, remote)) : false;
    const action = classifyCard({ local, remote, snapshot: previous, deletedLocally });
    const merge =
      action === "merge" || action === "reverse" || action === "reverse_create"
        ? mergeCardFields({ local: local || {}, remote: remote || {}, snapshot: previous })
        : { next: local, conflicts: [], applied: [] };
    items.push({ cardId, action, local, remote, merge });
  }

  return {
    items,
    counts: items.reduce((acc, item) => {
      acc[item.action] = (acc[item.action] || 0) + 1;
      return acc;
    }, {}),
  };
}

function issueList(rows, limit = 100) {
  const lines = rows.slice(0, limit).map((r) => `- \`${r.cardId}\` #${r.issueNumber ?? "?"} ${r.title || ""}`.trimEnd());
  if (rows.length > limit) lines.push(`- … ${rows.length - limit} more`);
  return lines;
}

export function renderReconcileReport({
  when,
  counts = {},
  duplicates = [],
  conflicts = [],
  orphans = [],
  failedCardIds = [],
  deletedLocally = [],
  remoteOnlyClosed = [],
  tokenWarning = null,
} = {}) {
  const lines = [
    "# Last card reconcile",
    "",
    `- **When:** ${when || new Date().toISOString()}`,
    `- **Plan:** ${
      Object.entries(counts)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ") || "empty"
    }`,
    "",
  ];
  if (tokenWarning) lines.push(`- **Token:** ${tokenWarning}`, "");

  const section = (title, rows, render) => {
    lines.push(`## ${title}`, "");
    if (!rows.length) lines.push("None.", "");
    else lines.push(...render(rows), "");
  };

  section("Duplicates", duplicates, (rows) =>
    rows.map((d) => `- \`${d.cardId}\` canonical #${d.keep}; extras ${d.extras.map((n) => `#${n}`).join(", ")}`)
  );
  section("Conflicts (owner applied)", conflicts, (rows) =>
    rows.map(
      (r) => `- \`${r.cardId}\`.${r.field}: git=\`${r.local}\` board=\`${r.remote}\` kept=\`${r.kept}\` (${r.winner || "owner"})`
    )
  );
  section("Forward failures (retried next run)", failedCardIds, (rows) => rows.map((id) => `- \`${id}\``));
  section("Deleted locally (issue kept open/closed, card not recreated)", deletedLocally, (rows) => issueList(rows));
  section("Closed issues without a local card (not recreated)", remoteOnlyClosed, (rows) => issueList(rows));
  section("Open issues without CARD_ID", orphans, (rows) => {
    const out = rows.slice(0, 100).map((issue) => `- #${issue.number} ${issue.title || ""}`.trimEnd());
    if (rows.length > 100) out.push(`- … ${rows.length - 100} more`);
    return out;
  });

  return `${lines.join("\n").trimEnd()}\n`;
}
