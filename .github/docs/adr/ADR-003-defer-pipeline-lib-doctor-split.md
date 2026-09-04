# ADR-003: Defer splitting pipeline-lib.mjs / cards-sync/doctor.mjs

## Status

Accepted (decision: defer, not do)

## Date

2026-09-04

## Context

Round-17 of the kit's own audit process (a fresh, zero-cache pass, same discipline as the rounds that produced ADR-001/ADR-002) flagged two files as large without the same explicit "should we split this" evaluation ADR-001 already gave `sync.mjs`/`lib.mjs`:

- `scripts/hyperion/pipeline-lib.mjs` — 1133 lines. About 480 of those (`renderSyncCardsWorkflow` through `renderAzureHyperionCi`, lines ~207-686) are literal YAML/workflow-file templates returned as template-literal strings, not branching logic — the file reads much bigger than its actual decision complexity.
- `scripts/cards-sync/doctor.mjs` — 750 lines. This one genuinely is mostly logic: per-backend healthcheck flows (GitHub Project fields, Jira/Azure/GitLab/Linear connectivity), each with its own required-env-var checks and remote calls.

Same precedent as ADR-001 applies here: this kit has already chosen, more than once, not to force a split just because a file crossed some line count, and has a working example (the GitHub backend staying inline in `sync.mjs`) of that judgment holding up.

## Decision

**Defer the split for both files.** No module boundaries are being drawn as part of this evaluation. As with ADR-001, this records that the tradeoff was weighed on purpose, with a concrete trigger condition for revisiting — not a decision to never look at it again.

## Options Considered

### Option A: Split now, by responsibility
`pipeline-lib.mjs` → separate the template renderers (`render*Workflow`/`render*Ci`) from the detection/planning logic (`detectPipeline`, `buildPipelinePlan`, `auditHyperionPipelineFiles`) into e.g. `pipeline-templates.mjs` + `pipeline-lib.mjs`. `doctor.mjs` → extract each backend's healthcheck into `backends/*-doctor.mjs`, mirroring the existing `backends/*.mjs` sync split.
- Pros: `pipeline-lib.mjs`'s split is genuinely low-risk — the templates are pure string-returning functions with no shared state, unlike `sync.mjs`'s module-level `dryRun`/`token`/`repositorySlug`. `doctor.mjs`'s split would mirror a pattern the kit already trusts (backend-per-file).
- Cons: `doctor.mjs`'s backend blocks are already reasonably self-contained `if (backend === "x") { ... }` clauses inside one file, not deeply entangled — the split would mostly move code, not simplify it, and would touch a file that just got its first real test suite (`doctor.test.mjs`, added this session) before that suite has proven itself against the current shape.

### Option B: Defer, revisit when a concrete pain point forces it
Same reasoning as ADR-001 Option B: leave both files as-is until a specific change becomes hard to make *because* of the size, not because a line count crossed a threshold.
- Pros: zero risk today; `doctor.mjs` just gained real test coverage this session (17 tests) precisely by extracting its pure helpers and isMain-guarding its side-effecting flow — a change that improved testability without touching the file's overall shape or size.
- Cons: both files keep growing; a later split is a bigger diff than doing it now while `pipeline-lib.mjs`'s low-risk half (the templates) is still easy to lift out.

### Option C: Split only the genuinely low-risk half now
Extract `pipeline-lib.mjs`'s template renderers into their own file today (Option A's low-risk part), since they're pure and stateless, while leaving `doctor.mjs` and `pipeline-lib.mjs`'s detection/planning logic deferred under Option B.
- Pros: shrinks the one file where the split is nearly free, without touching the riskier one.
- Cons: still a diff to review and get right in a round that's mostly bug fixes, not refactors; not obviously more valuable than doing it the next time someone touches a template anyway.

## Consequences

### Positive
- Zero regression risk — nothing about the pipeline-detection or per-backend healthcheck behavior changes.
- `doctor.mjs` already got a real, independent quality improvement this session (test coverage) that doesn't depend on this ADR's outcome either way.

### Negative
- Both files remain large; `pipeline-lib.mjs`'s template/logic split stays undone even though it's the closer-to-free option.

### Risks
- **Drift risk if deferred indefinitely**, same as ADR-001: written trigger condition here is what keeps "defer" from silently becoming "never." Split `pipeline-lib.mjs`'s templates out the next time a workflow template needs a non-trivial change (not on a schedule); split `doctor.mjs` by backend if a bug specific to one backend's healthcheck becomes hard to isolate from the others in the same file.

## References

- ADR-001 (`sync.mjs`/`lib.mjs` split, same reasoning pattern, same "defer with a real trigger" structure).
- [Painel Hyperion](https://claude.ai/code/artifact/65052811-fb21-49b5-b17e-ba184fcb45ee) / [Backlog de fechamento](https://claude.ai/code/artifact/4790a8a3-b263-4322-bff6-8ae6cb619976) — rodada 17 finding this ADR responds to.
