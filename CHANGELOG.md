# Changelog

All notable changes to the **Hyperion** kit are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/) for kit releases (tags on this repo).

## [Unreleased]

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

### Fixed
- **`cards:dry-run` was writing to disk** — project auto-discovery persisted the real owner/project-number to `projects-map.json` even during a "preview".
- **`.github/instructions/copilot-instructions.md` matched no convention GitHub Copilot actually reads** — moved to `.github/copilot-instructions.md`.
- **`hyperion:pipeline-plan` claimed to create workflow files that already existed on disk** (two instances — the generic branch and a deeper one in the product-CI branch).
- **`hyperion:upgrade`'s dry-run leaked a temp directory on every run** (a `process.exit(0)` skipped its own cleanup `finally` block) — reproduced ~70 accumulated leaked directories on the maintainer's machine before the fix.
- **`memory/PROJECT.md: filled` false-positive** in `hyperion:doctor` — an unfilled scaffolded template passed a length/keyword heuristic; now checks real per-section content.
- **`install-hook.mjs` ignored nested `kit.root` layout** — installed pre-commit hook validated nothing for a nested adopter.
- **Dogfood `project.yml` failed its own `hyperion:project-verify`** — pointed `apps.api` at a `src/` directory this repo never had; now points at `scripts/`.
- Doc drift: 3 docs claimed Linear reverse sync was unsupported after it had already shipped; 8 dead references to a moved `exemplars.md` path (one of which self-propagated into every card `card-refiner` generates).
- `cards:doctor` could hang waiting on stdin in a non-TTY context (CI/agent shells) — `--interactive` no longer overrides a real TTY check.

### Security / CI
- `hyperion-sync-cards.yml`: `cancel-in-progress` changed to `false` — the workflow performs non-transactional board writes, so a second trigger now queues instead of risking a half-applied sync.
- `hyperion-security.yml`: added a `pull_request` trigger (previously weekly-cron-only, up to a 6-day detection gap for a secret landing in a PR).
- `contents: read` pinned on the 2 workflows that had no `permissions:` block at all (`hyperion-validate.yml`, `hyperion-product-ci.yml` — the latter runs on every push/PR).
- Documented (not "fixed" — a considered decision) why fork-PR board-guard deliberately stays validate-only: giving fork PRs the same board token same-repo PRs get would be a real vulnerability (the checked-out PR head SHA is attacker-controlled for a fork).

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

[Unreleased]: https://github.com/MatheusFelipeCorrea/Hyperion/commits/main
[0.1.0]: https://github.com/MatheusFelipeCorrea/Hyperion/commits/main

<!-- Cut GitHub Release `v0.1.0` when you publish; then point these anchors at the tag/compare URLs. -->
