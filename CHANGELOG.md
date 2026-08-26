# Changelog

All notable changes to the **Hyperion** kit are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/) for kit releases (tags on this repo).

## [Unreleased]

### Added
- Nested card layout by parent `card_id` (`features/{EPIC}/…`, `stories/{FEATURE}/…`, `tasks/{PARENT}/…`) with `resolveCardRelativePath`, `cards:migrate-layout`, and validate layout warnings (`--strict-layout`).

### Changed
- `_examples/` and `card-refiner` teach nested-by-parent paths; sync discovery unchanged (already recursive).

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
