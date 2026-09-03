# Changelog

All notable changes to the **Hyperion** kit are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/) for kit releases (tags on this repo).

## [Unreleased]

### Added
- **`hyperion:distribution-purity-check`** — a fail-closed gate that codifies "this repo carries no binding to itself" as an automated, required CI check instead of something that has to be re-discovered by hand: no real GitHub Project number persisted, `hyperion-sync-cards.yml` never gets a `push` trigger back, `CODEOWNERS`/`FUNDING.yml` never end up in `MANAGED_FILES`, no real backlog card outside `_examples/`, no committed doc under `.github/plans/` beyond the `.gitkeep` scaffolds, no leaked absolute personal filesystem path. Wired into `hyperion-validate.yml`, which now also runs on `dev`/`qa` (not just `main`) — this is the required check gating a new `dev → qa → main` (+ `internal`) branch model, documented in `CONTRIBUTING.md`.

### Fixed
- **`sync.mjs` could create a duplicate GitHub Project** when automatic Project discovery was ambiguous (an account with more than one Project candidate) — `pickBestGitHubProject` picked the first regex match instead of checking for uniqueness, and the caller didn't check for an "ambiguous" discovery result before falling through to auto-create. Fixed both: `pickBestGitHubProject` now prefers a repo-named board and only returns a single unambiguous match, and auto-create is skipped when discovery reports ambiguity.
- **`install-hook.mjs` had no entrypoint guard** — importing the module (as its own test did) ran `main()` for real, silently installing/mutating a pre-commit hook in whatever repo happened to be the current working directory. Guarded with the same `pathToFileURL` pattern used elsewhere in the kit; added regression tests (import vs. direct-run).
- **`install-hook.mjs` assumed `.git` is always a directory** — broke with `ENOENT` in a git worktree or submodule, where `.git` is a file pointing elsewhere. Now resolves the real hooks directory via `git rev-parse --git-path hooks`; added a regression test that reproduces a real worktree.
- **`sync.mjs`/`doctor.mjs` fell back to your local `gh auth token` session silently** when no `PROJECT_SYNC_TOKEN`/`GITHUB_TOKEN` was set — making real GitHub API calls under your own identity with no warning. Both now log an explicit warning when this happens; `doctor.mjs` no longer shows a green check for "no token available".
- **`pipeline-lib.mjs`'s default-branch fallback read `.git/refs/heads/*` directly** — same worktree/submodule blind spot as above. Now asks git itself (`git rev-parse --verify`).
- **`getLabelId`'s create/retry race (PR #66) had zero unit coverage** — only ever exercised by the opt-in E2E test. Exported it and added mocked-fetch tests covering the create path, the "name already taken" race, and unrelated errors re-throwing.
- **Backend config errors (Jira/Azure/GitLab/Linear) printed a raw stack trace** for an entirely expected "you haven't configured this backend yet" case. `sync.mjs` now prints just the actionable message unless `--verbose` is passed.
- **`.github/mcp/servers.example.json` referenced two npm packages that don't exist** (`@atlassian/mcp-server-jira`, `@azure-devops/mcp-server`) — replaced with real packages (`mcp-atlassian`, the official `@azure-devops/mcp`), and aligned the README's server names with the JSON's actual keys.
- **`hyperion:llm-eval`'s live mode was 100% inoperative** regardless of API key — `.github/skills/eval/prompts/` didn't exist, and `ANTHROPIC_API_KEY` was accepted by the key check but the Anthropic call path threw "not wired yet". Implemented the real Anthropic call, added the missing prompts, and documented both eval modes in a new `.github/skills/eval/README.md`.
- **English PM onboarding was a redirect loop** — `trilha-pm.md`'s English section pointed at `learning-path-en.md`, which pointed back at `trilha-pm.md` (Portuguese-only), with no real English content anywhere. Added `pm-track-en.md` and pointed both sides at it directly.
- **`.gitignore`'s kit-managed lines were never propagated by `hyperion:upgrade`** — adopters missed new ignore rules (e.g. `sync-history.jsonl`) added to the kit's own `.gitignore`. Added a marker-guarded merge (`mergeGitignore`), same pattern as the existing `package.json` merge, so adopter-added lines are never touched.
- **`.github/FUNDING.yml` shipped live** (not as a template) with the maintainer's personal GitHub handle, and was in `MANAGED_FILES` — every `hyperion:upgrade` silently propagated it to adopters. Removed from `MANAGED_FILES` (same treatment as `CODEOWNERS`: this repo's own config, not adopter-facing), documented in `GETTING-STARTED.md`'s copy table.
- An internal maintainer planning doc (`gap-closure-action-plan.md`, referencing an internal dogfood repo and token setup notes) was committed directly under `.github/plans/` and shipped in every clone/`npm pack` — moved into the already-`.gitignore`d `.github/plans/implementations/`.

## [0.2.0] — 2026-09-02

### Added
- Nested card layout by parent `card_id` (`features/{EPIC}/…`, `stories/{FEATURE}/…`, `tasks/{PARENT}/…`) with `resolveCardRelativePath`, `cards:migrate-layout`, and validate layout warnings (`--strict-layout`).
- `kit.root` path resolver (`scripts/hyperion/paths.mjs`) — kit may live at `produto/Hyperion/`; auto-detect + `HYPERION_ROOT` + `project.yml`.
- `hyperion:init -- --adopt` / `hyperion:install-shims` — product-root shims for nested adoption without scattering kit files.
- Labels v2 catalog (39 labels, color + description) and Status columns v2 (7 columns, semantic palette) with locale-aware loading.
- Bidirectional sync hardening: directional board guard (`board-guard`), merge-queue support, cron-based PR recheck.
- **Linear backend now supports reverse sync** (`runReverseSyncLinear`) — forward-only until this release.
- `labels.custom.json` / `status-columns.custom.json` — optional per-repo overlay merged into the base locale catalog, so a product can add domain-specific labels/columns without forking the kit's generic catalog.
- Real JSON-Schema validation: `project.yml` is now checked against `project.schema.json` with `ajv` (draft 2020-12) in `hyperion:project-verify`, in addition to the existing path-existence checks. First runtime dependency this repo has ever had (`ajv`, `js-yaml`) — added `package-lock.json` accordingly.
- Structural eval (`hyperion:*-verify`) for 4 more agents that previously had none: `audit-runner`, `spec-review`, `release`, `implementation-plan`. `skills-eval` now covers all 30/30 skills (was 20/30).
- Opt-in E2E test (`hyperion-e2e-cards.yml`, `workflow_dispatch` only) that runs a real forward-sync against a disposable GitHub repo — the existing unit tests only ever mocked `fetch`.
- `CODEOWNERS`, `npm` ecosystem enabled in `dependabot.yml`, `windows-latest` added to the kit-validation CI matrix, Docker image now published to `ghcr.io` on version tags, CycloneDX SBOM generated and attached to each GitHub Release (`hyperion:sbom`).
- `scripts/cards-sync/sync.mjs` (3,929 LOC) split: Jira/Azure/GitLab/Linear backends moved to `scripts/cards-sync/backends/`, shared helpers moved to `lib.mjs` — GitHub (default backend) stays inline. Pure extraction, same exports/behavior; sync.mjs is now 2,211 lines.
- **Gap closure (scorecard):** append-only `sync-history.jsonl` for forward-sync and pr-guard events; MCP reference config (`.github/mcp/`); `docs:prose-check`; `hyperion:llm-eval` (fixture CI + opt-in live); POC/Prototype/Spike decision tree in `card-refiner`; PM learning path (`trilha-pm.md`); pre-commit hook regen rules on `commands.yml`; upgrade writes adopter `CHANGELOG`; `test:coverage`; `FUNDING.yml` template.

### Fixed
- **`cards:dry-run` was writing to disk** — project auto-discovery persisted the real owner/project-number to `projects-map.json` even during a "preview".
- **`.github/instructions/copilot-instructions.md` matched no convention GitHub Copilot actually reads** — moved to `.github/copilot-instructions.md`.
- **`hyperion:pipeline-plan` claimed to create workflow files that already existed on disk** (two instances — the generic branch and a deeper one in the product-CI branch).
- **`hyperion:upgrade`'s dry-run leaked a temp directory on every run** (a `process.exit(0)` skipped its own cleanup `finally` block) — reproduced ~70 accumulated leaked directories on the maintainer's machine before the fix.
- **`memory/PROJECT.md: filled` false-positive** in `hyperion:doctor` — an unfilled scaffolded template passed a length/keyword heuristic; now checks real per-section content.
- **`install-hook.mjs` ignored nested `kit.root` layout** — installed pre-commit hook validated nothing for a nested adopter.
- **Dogfood `project.yml` failed its own `hyperion:project-verify`** — pointed `apps.api` at a `src/` directory this repo never had; now points at `scripts/`.
- Doc drift: 3 docs claimed Linear reverse sync was unsupported after it had already shipped; 8 dead references to a moved `exemplars.md` path (one of which self-propagated into every card `card-refiner` generates).
- **`hyperion:init --prefix` install path failed 100% of the time** — `install-product-shims.mjs` used `process.cwd()` instead of resolving from script location.
- **`npm install` undocumented** — `project-verify` crashed with raw Node stack trace when `ajv` missing; docs + friendly error added.

### Security / CI
- `hyperion-sync-cards.yml`: `cancel-in-progress` changed to `false` — the workflow performs non-transactional board writes, so a second trigger now queues instead of risking a half-applied sync.
- `hyperion-security.yml`: added a `pull_request` trigger (previously weekly-cron-only, up to a 6-day detection gap for a secret landing in a PR).
- `contents: read` pinned on the 2 workflows that had no `permissions:` block at all (`hyperion-validate.yml`, `hyperion-product-ci.yml` — the latter runs on every push/PR).
- Documented (not "fixed" — a considered decision) why fork-PR board-guard deliberately stays validate-only: giving fork PRs the same board token same-repo PRs get would be a real vulnerability (the checked-out PR head SHA is attacker-controlled for a fork).
- E2E guard bypass via `.git` suffix on repo name — normalized before guard comparison.
- Windows CI: `continue-on-error` removed from `hyperion-validate.yml` after local parity verified.

### Changed
- `_examples/` and `card-refiner` teach nested-by-parent paths; sync discovery unchanged (already recursive).
- README / GETTING-STARTED prefer “paste the Hyperion folder” adoption; legacy selective copy still documented.
- Cards-sync / doctor / watch / validate resolve cards via `kit.root` (legacy root layout still default for this repo).

## [0.1.0] — 2026-08-21

First public-adoption polish on `main`.

### Added
- Community health: Code of Conduct, Security policy, issue/PR templates, CONTRIBUTING updates, good-first issues.
- Brand assets (banner/logo) and navy/blue/amber diagram palette on the docs hub.
- Cards sync: skip EXAMPLE/TEMPLATE/SAMPLE remote issues on reverse sync and issue maps (`is:issue` only).

### Changed
- README as study hub (five areas, skills tables, copy / don’t-copy guidance).
- Skills catalog generator emits branded headers (CI `--check` stable).

[Unreleased]: https://github.com/MatheusFelipeCorrea/Hyperion/compare/v0.2.0...main
[0.2.0]: https://github.com/MatheusFelipeCorrea/Hyperion/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MatheusFelipeCorrea/Hyperion/releases/tag/v0.1.0

<!-- Cut GitHub Release `v0.1.0` when you publish; then point these anchors at the tag/compare URLs. -->
