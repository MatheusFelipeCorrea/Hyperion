# ADR-001: Defer splitting sync.mjs / lib.mjs into smaller modules

## Status

Accepted (decision: defer, not do)

## Date

2026-09-03

## Context

`scripts/cards-sync/sync.mjs` (2259 lines) and `scripts/cards-sync/lib.mjs` (1500+ lines) each concentrate multiple responsibilities — sync.mjs alone covers GitHub forward sync, reverse sync, Project field mapping, label management, and CLI argument parsing. Round-10 of the kit's own audit process flagged this as a manutenibilidade gap: large files raise the cost of understanding any single change, since a contributor has to hold more of the file in their head than the change itself requires.

The kit already has one concrete precedent bearing on this exact question: when Jira/Azure/GitLab/Linear were extracted into `scripts/cards-sync/backends/`, GitHub was deliberately **left inline** in `sync.mjs` rather than extracted to a fifth backend file, specifically because GitHub is the default, most-exercised path and the team judged the extraction risk (subtle behavior drift during the move) higher than the maintainability payoff for that specific piece.

## Decision

**Defer the split.** No module boundaries are being drawn in sync.mjs/lib.mjs as part of this evaluation. This ADR exists to record that the tradeoff was actually weighed, not skipped, and to give a future attempt a starting point instead of a blank page.

## Options Considered

### Option A: Split now, by responsibility
Break `sync.mjs` into e.g. `sync-github-forward.mjs`, `sync-github-reverse.mjs`, `sync-project-fields.mjs`, `sync-labels.mjs`, wired through a thin orchestrator.
- Pros: smaller files, clearer ownership per concern, easier onboarding for a specific area.
- Cons: real risk of behavior drift during the move (shared module-level state like `dryRun`, `token`, `repositorySlug` currently computed once at the top of the file would need explicit passing or a shared context object); every backend file and `watch.mjs`/`ci-sync.mjs` import from `sync.mjs` today (`log`, `dryRun`, `cardsRoot`, helper functions), so the public surface has to be preserved exactly or every consumer needs auditing too; this is exactly the risk the GitHub-backend-stays-inline precedent was already weighed against once.

### Option B: Defer, revisit when a concrete pain point forces it
Leave the files as-is until a specific change becomes hard to make *because* of the size (not hypothetically).
- Pros: zero risk today; the two files currently pass all 218 tests and every recent change to them (backend parity, concurrency, telemetry) landed cleanly without the size being an obstacle in practice; a real forcing function (a bug that's hard to isolate, a contributor who gets lost) is a much better signal for *where* to split than a line-count threshold.
- Cons: the files keep growing in the meantime; the eventual split, whenever it happens, will be a bigger diff than if done incrementally now.

### Option C: Incremental extraction of net-new code only
Don't touch existing code; require any *new* sync.mjs functionality to land in a separate module from day one (e.g. this session's `mapWithConcurrency` already went into `lib.mjs` as a distinct exported utility, not inlined into the loop bodies).
- Pros: no risk to existing behavior, stops the problem from getting worse, costs nothing extra per PR.
- Cons: doesn't reduce the existing 2259/1500-line files at all; the real gap (existing code is hard to navigate) stays open.

## Consequences

### Positive
- Zero regression risk from this decision — nothing in the sync path changes.
- Option C is compatible with Option B and is already the de facto pattern this session (new concurrency helper landed in `lib.mjs` as a standalone export, not inline).

### Negative
- The manutenibilidade gap stays open; `sync.mjs`/`lib.mjs` remain the two largest files in the kit.
- Anyone reading `sync.mjs` cold still has to hold GitHub forward-sync, reverse-sync, and Project-field logic in mind together.

### Risks
- **Drift risk if deferred indefinitely**: without a trigger condition, "defer" can silently become "never." Mitigation: the trigger in Option B is written down here explicitly — split when a specific bug or onboarding friction is traceable to the file's size, not on a schedule.

## References

- Precedent: GitHub kept inline vs. the 4 extracted backends (`scripts/cards-sync/backends/`), documented in `scripts/cards-sync/README.md`'s "Manutenção" section.
- [Painel Hyperion](https://claude.ai/code/artifact/65052811-fb21-49b5-b17e-ba184fcb45ee) / [Backlog de fechamento](https://claude.ai/code/artifact/4790a8a3-b263-4322-bff6-8ae6cb619976) — origin of this evaluation (Backlog lane, "Manutenibilidade").
