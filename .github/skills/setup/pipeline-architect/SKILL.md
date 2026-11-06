---
name: pipeline-architect
description: >-
  Detects existing CI/CD, scans the whole repository for possible quality gates
  (lint/format + auto-fix, typecheck, tests, coverage + diff coverage, build,
  audit + audit fix, migrations, toolchain matrix, test service containers,
  Docker lint/build/scan/publish, compose, e2e, IaC, commitlint, CodeQL,
  dependency review, secrets, PR hygiene, Lighthouse/a11y/bundle size, mobile
  builds, docs, notifications) and interviews the person about each one
  (presets, remembered refusals, CI-minute estimate, preview diff) before
  writing ci.gates and rendering hyperion-product-ci.yml. Never overwrites
  product pipelines. Use for
  /pipeline, "monta CI", "configura pipeline", "quero gate de cobertura",
  or when setup finds workflow conflicts.
---

# Pipeline Architect — adaptive CI/CD

Hyperion workflows use the **`hyperion-`** prefix and **never overwrite** your
existing `ci.yml`, `deploy.yml`, GitLab CI, Azure Pipelines, etc. when
`ci.policy` is `detect` (default).

The person configuring the pipeline decides **every gate**. Hyperion scans,
proposes, explains the trade-off and writes only what was accepted.

## Triggers

| User says | Action |
|-----------|--------|
| `/pipeline` | Run this skill (all steps) |
| "Monta CI para este projeto" | Run this skill |
| "Quero gate de cobertura / styles / audit" | Step 1 + Step 3 for that gate only |
| "Não sobrescreve minha pipeline" | Explain detect policy + run detect |
| Greenfield repo sem CI | policy `hyperion-only` or `detect` + gates interview + apply |

## Output

| Artifact | Path |
|----------|------|
| CI policy + accepted gates | `.github/project.yml` → `ci:` (`ci.gates`) |
| Hyperion workflows | `.github/workflows/hyperion-*.yml` |
| Product CI from gates | `.github/workflows/hyperion-product-ci.yml` (`# hyperion:gates-hash`) |
| Merge guide (merge mode) | Reference `.github/docs/integration/pipeline-merge.md` |

## Step 1 — Detect (always run terminal)

```bash
npm run hyperion:pipeline-detect
npm run hyperion:pipeline-plan
npm run hyperion:pipeline-gates            # whole-repo scan + question list (project.yml locale; --lang <tag>)
npm run hyperion:pipeline-gates -- --json  # machine-readable: scan + questions (+ status) + estimate
npm run hyperion:pipeline-gates -- --pending   # only questions not answered/declined in ci.gates
```

`pipeline-gates` walks the whole repo (depth 5, skips `node_modules`, build
output, the kit folder) and finds **every app** by manifest — monorepos,
`Codigo/<app>/` layouts, Flutter + API + web side by side. Per app it detects
the package manager, install command, each gate's command and fix command,
the **toolchain version** (`.nvmrc`, `.tool-versions`, `engines`,
`requires-python`, `go.mod`, `global.json`, `.java-version`, `.fvmrc`…),
**services the tests need** (Prisma provider, driver deps such as `pg`,
`ioredis`, `psycopg`, `amqplib`, compose next to the app), the **migrate
command**, **web framework + build output** (Next, Vite, Angular, CRA…),
**size-limit** and **mobile targets** (Flutter android/ios, Android Gradle).
Per repo it finds Dockerfiles (+ `.hadolint.yaml`), compose files, Playwright/
Cypress, Terraform/Helm, OpenAPI specs, commitlint, Markdown docs, release
tooling, deploy targets, Dependabot/Renovate, CODEOWNERS and local hooks.

Summarize for the user:
- Provider, policy, existing **product** workflows vs **hyperion-** workflows
- Table: app → stack → detected gates (command + evidence)
- Repo-level findings (Docker, compose services, e2e, IaC…)
- What is **missing** per app (no formatter, no coverage tool…)

## Step 2 — Choose policy

| Policy | When to use |
|--------|-------------|
| **`detect`** (default) | Repo may already have CI — add only `hyperion-*` |
| **`hyperion-only`** | Greenfield — generate `hyperion-product-ci.yml` if no product CI |
| **`merge`** | Mature CI — document manual job injection, no auto-write |
| **`skip`** | User manages all workflows manually |

Ask if unclear. Write or update `ci:` in `project.yml` (show diff).

If product CI already exists, ask (in the repo language): **"Should Hyperion
generate the gates in `hyperion-product-ci.yml` next to your CI, or only
recommend them?"** With
gates configured the file runs **in addition** to existing workflows — turn
overlapping gates `off`.

### `ci.hyperion` flags

| Flag | Default | Meaning |
|------|---------|---------|
| `cards_sync` | true | `hyperion-sync-cards.yml` |
| `kit_validation` | false | `hyperion-validate.yml` (kit maintainers: true) |
| `security_scan` | true | `hyperion-security.yml` |
| `product_ci` | auto | `auto` = only when no product CI (or when `ci.gates` exists) · `true` = always · `false` = never (wins over gates) |
| `cards_sync_mode` | pull-forward | `pull-forward` = git is the source of truth, board drift blocks PRs · `auto` = two-way reconcile (board status/sprint committed back with `[cards-sync]`, push + issues + 30 min schedule; needs `PROJECT_SYNC_TOKEN`) |

## Step 3 — Gates interview (ask EVERY applicable question)

Use the question list from `pipeline-gates --json` (`questions[]`). Each
question carries `id`, `question.pt/en/es` (ask in the repo `locale`; other
languages fall back to `en`), `options`, `recommended`, the
detected `command`/`evidence`, the `yaml` path it writes to and a `status`:
`new`, `answered` (the path already exists in `ci.gates`) or `declined`
(listed in `ci.gates.declined`).

**How to ask**

1. **Preset first** (`preset` question): `minimal`, `balanced` (recommended)
   or `strict`. The preset fills every answer; the person only changes what
   differs. `custom` = no preset, ask everything.
2. Group by category, in this order: triggers/settings → per-app gates (one
   app at a time: gates, fix, coverage, toolchain, services, retry) →
   docker/compose → e2e/IaC/contract → security → PR process → web/mobile →
   docs → reporting → process/maintenance.
3. Use the structured question tool (multiple choice) when available; one
   batch per app/category, never one giant form.
4. For every gate show **what will run** (command), **why it was detected**
   (evidence), the **recommended mode** and the cost (CI minutes, flakiness,
   secrets needed).
5. Modes: `block` (fails the pipeline) · `warn` (runs, annotates, never fails)
   · `off`. Offer **warn first, block later** for coverage/audit on existing
   code ("ratchet"); for legacy code prefer **diff coverage** over a global %.
6. Ask follow-ups only when the gate is accepted.
7. When a gate is **not detected** (`*.adopt` questions), offer: configure the
   tool now (agent edits manifests/config, separate commit), provide a custom
   command (`ci.gates.apps.<app>.commands.<gate>`), or skip.
8. Never assume: if the person skips a question, write nothing for it
   (defaults/preset apply — show which). When they **refuse** a suggestion,
   add its `id` to `ci.gates.declined` so the next `/pipeline` run
   (`--pending`) does not ask again.
9. Re-running `/pipeline` on a configured repo: ask only `status: new`
   questions (new apps, new Dockerfile, new web app…).

### Question catalog

**Triggers and settings**
| Question | Writes |
|----------|--------|
| Preset (minimal / balanced / strict / custom) | `ci.gates.preset` |
| Branches that run on push (default, + dev/develop, custom) | `ci.gates.branches` |
| Run on every pull request? | `ci.gates.pull_request` |
| Skip docs-only changes (`**/*.md`, `docs/**`)? | `ci.gates.paths_ignore` |
| Run on the merge queue (`merge_group`)? Default yes | `ci.gates.merge_group` |
| Runner label + timeout | `ci.gates.runner`, `ci.gates.timeout_minutes` |
| Keep coverage/test reports as artifacts (7 days)? | `ci.gates.artifacts` |
| Monorepo: on PRs run only changed apps? Shared paths? | `ci.gates.affected` (`paths`) |

**Per app** (`ci.gates.apps.<app>.*`, or `ci.gates.defaults.*` for all apps)
| Gate | Question | Follow-ups |
|------|----------|------------|
| `lint` | Lint gate? | — |
| `format` | **Styles gate** — fail when code is not formatted (prettier/biome/ruff format/black/dart format/gofmt/rustfmt/dotnet format/spotless/php-cs-fixer/pint)? | Show the local fix command (`fixHint`) — offer a pre-commit hook |
| `format.fix` / `lint.fix` | **Auto-fix on PRs**: `off` · `suggest` (review suggestions via reviewdog) · `commit` (pushes `style: auto-fix` to the PR branch; needs `HYPERION_PR_TOKEN` to re-trigger CI). Fork PRs are skipped | — |
| `typecheck` | Typecheck gate (tsc/vue-tsc/mypy/sorbet)? | — |
| `test` | Run tests as a gate? | Custom test command for CI? |
| `retry` | Flaky tests: retry the test step 0–3 times? Recommend fixing instead | — |
| `coverage` | **Coverage gate**? | metric (lines/statements/branches/functions) · min % · paths excluded (generated code, screens, `*.g.dart`) · warn-first ratchet · install missing provider (`needs`, e.g. `@vitest/coverage-v8`, `pytest-cov`) · **PR comment** (`comment: true`) · **diff coverage** (`diff: { mode, min }` — % of changed lines covered) |
| `build` | Build as a gate? | — |
| `audit` | **Dependency audit gate**? | severity (low/moderate/high/critical, when the tool supports it) · **audit fix**: `off` · `check` (CI applies the fix, runs tests, reverts, warns if it is safe or breaks) · `pr` (weekly scheduled job opens a PR with the fix) |
| `migrations` | Check migrations (prisma validate, django makemigrations --check, rails status)? | — |
| `matrix` | Detected version X — single version, versions matrix, OS matrix? (libraries: recommend versions) | `matrix: { versions: [...], os: [...] }`; coverage/audit run on the first combination |
| `services` | Tests use postgres/mysql/mariadb/mongo/redis/rabbitmq — start service containers and export `DATABASE_URL`/`REDIS_URL`/…? | `services: auto` · list · `{ postgres: "postgres:15" }` (Linux runners only) |
| `migrate` | Apply migrations to the test DB before tests (`prisma migrate deploy`, `manage.py migrate`, `alembic upgrade head`, `artisan migrate`, `rails db:prepare`)? | `true` or a command |

**Repo level**
| Gate | Question | Writes |
|------|----------|--------|
| Docker build | Build every Dockerfile found? | `ci.gates.docker.build` |
| Docker scan | Scan images with Trivy (HIGH,CRITICAL)? | `ci.gates.docker.scan`, `severity` |
| Docker lint | hadolint every Dockerfile? | `ci.gates.docker.lint` |
| Docker cache | buildx + GitHub Actions cache? | `ci.gates.docker.cache` |
| Docker publish | Push to GHCR on main + `v*` tags after all gates pass? | `ci.gates.docker.publish` (`branches`, `tags`, `platforms`) |
| Compose smoke | Bring compose services up with `--wait`, run a check, tear down? | `ci.gates.compose_smoke` (`file`, `services`, `check`) — credentials stay in `.env.example`, never in the workflow |
| E2E | Run Playwright/Cypress (slower; maybe PRs to main only)? | `ci.gates.e2e` |
| IaC | `terraform fmt -check` + `validate` (no backend)? | `ci.gates.iac` |
| Contract | Lint OpenAPI specs (Redocly)? | `ci.gates.openapi` |
| Commits | Validate PR commit messages (commitlint / Conventional Commits)? | `ci.gates.commitlint` |
| Security | CodeQL (free on public repos; private needs GHAS)? | `ci.gates.codeql` |
| Security | Dependency review on PRs (new vulnerable deps)? Severity? | `ci.gates.dependency_review` |
| Security | Secrets scan (gitleaks over the commit range)? | `ci.gates.secrets_scan` |
| PR process | Branch name, Conventional Commits title, CARD_ID link, max diff size? | `ci.gates.pr_checks` (`branch_name`, `title`, `card_link`, `size`, custom `pattern`) |
| Web | Lighthouse CI with minimum scores? | `ci.gates.lighthouse` (`app`, `urls`, `min`) |
| Web | axe accessibility on the served app? Routes? | `ci.gates.a11y` (`urls`) |
| Web | Bundle size budget (size-limit) — or adopt it? | `ci.gates.bundle_size` / `apps.<app>.commands.bundle_size` |
| Mobile | Debug APK (+ unsigned iOS on macOS, 10x minutes) as artifact? | `ci.gates.mobile_build` (`android`, `ios`) |
| Docs | Broken links (lychee, offline by default) + markdownlint? | `ci.gates.docs` (`links`, `external`, `markdown`) |
| Reporting | Slack/Discord on push failures (`failure`/`always`)? | `ci.gates.notify` — secrets `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL` |

**Process / maintenance** (agent actions, not workflow gates — confirm each)
| Question | Action |
|----------|--------|
| No Dependabot/Renovate — create `.github/dependabot.yml`? | Weekly updates per ecosystem found; `target-branch` = integration branch (e.g. `dev`) |
| No CODEOWNERS — create one per area? | `.github/CODEOWNERS` |
| Local pre-commit hook for format/lint? | husky / lefthook / pre-commit, matching the stack |
| Mark `block` jobs as required checks? | Show the job names; apply via rulesets only with explicit approval |
| Cards: should moving a card on the board update the markdown automatically (`cards_sync_mode: auto`), or keep git as the only source (`pull-forward`)? | `ci.hyperion.cards_sync_mode` + `pipeline-apply --refresh-sync --yes`; preview with `npm run cards:auto -- --dry-run` |
| Allow Actions to open PRs (needed by `audit.fix: pr`)? | Settings → Actions → "Allow GitHub Actions to create pull requests", or secret `HYPERION_PR_TOKEN` so the PR triggers CI |

### Not rendered yet (record as suggestions)

Deploy environments/OIDC, release automation (semantic-release, changesets,
release-please), preview deploys, SonarCloud, mutation testing, action SHA
pinning and GitLab/Azure parity are designed in
`.github/docs/integration/pipeline-cd-design.md` but not rendered. When the
person wants one now, write it by hand in a **non-hyperion** workflow. Also
mention: Turborepo/Nx remote cache, SBOM/licenses (`hyperion-security.yml`).

### Write `ci.gates`

Start from the draft, apply the answers, then **show cost and diff before
writing** project.yml:

```bash
npm run hyperion:pipeline-gates -- --yaml --preset balanced   # preset draft (only repo-specific overrides)
npm run hyperion:pipeline-gates -- --yaml                     # full draft without preset
# save the edited block to a temp file, then:
npm run hyperion:pipeline-gates -- --preview --gates-file draft.yml   # CI minutes + line diff of hyperion-product-ci.yml
npm run hyperion:pipeline-gates -- --estimate --preset strict          # compare presets by cost
npm run hyperion:pipeline-gates -- --preview --diagram --gates-file draft.yml   # + Mermaid diagram of the jobs
```

Tell the person the estimate (`≈ N min per push · M per PR update`; macOS
10x, Windows 2x, public repos free) and the diff summary before asking for
approval. `--preview` never writes.

**Offer the pipeline diagram.** Ask *"Quer ver/salvar o diagrama da pipeline?"*
— before approval, show the Mermaid from `--preview --diagram` (jobs, `needs`,
triggers, block = red / warn = amber, PR-only and affected-only conditions).
After applying, save it with `npm run hyperion:pipeline-diagram -- --write`:
Mermaid + PlantUML under `<diagrams>/Pipeline/` for `ci.gates` and every
existing `.github/workflows/*.yml`, plus a `README.md` GitHub renders inline.
It is the same Pipeline type the `plantuml-generator` (`/diagram`) skill uses.

```yaml
ci:
  policy: detect
  gates:
    preset: balanced                  # explicit keys below win
    declined: [notify, docker.publish]
    branches: [main, dev]
    affected: { paths: ["packages/shared/**"] }
    defaults:
      lint: block
      format: block
      typecheck: block
      test: block
      build: block
      format: { mode: block, fix: suggest }
      coverage: { mode: warn, metric: lines, min: 80, comment: true, diff: { mode: block, min: 80 } }
      audit: { mode: warn, level: high, fix: check }
    apps:
      api:
        path: Codigo/app/api
        coverage: { mode: block, min: 89 }
        migrations: block
        services: auto               # postgres + rabbitmq detected
        migrate: true                # prisma migrate deploy before tests
        matrix: { versions: [20, 22] }
      mobile:
        path: Codigo/app/mobile
        coverage: { mode: block, min: 89, ignore: ["lib/screens/**", "*.g.dart"] }
      legacy-admin: off              # exclude an app
      docs:                          # app the scanner cannot detect
        path: docs
        stack: custom
        commands: { install: pip install mkdocs, build: mkdocs build --strict }
    docker: { build: block, scan: warn, lint: warn, cache: true, publish: true }
    compose_smoke: { mode: warn, services: [rabbitmq], check: npm run rabbit:check }
    e2e: warn
    dependency_review: warn
    secrets_scan: block
    pr_checks: { branch_name: warn, title: block, card_link: warn, size: 800 }
    lighthouse: { mode: warn, urls: ["/", "/login"] }
    mobile_build: { mode: warn, ios: false }
    docs: { links: block, markdown: warn }
    notify: { on: failure }
    commitlint: off
    codeql: off
```

`npm run hyperion:project-verify` validates the block against
`project.schema.json`.

## Step 4 — Apply (with user approval)

```bash
npm run hyperion:pipeline-plan                     # shows "Product CI from ci.gates (N apps)"
npm run hyperion:pipeline-apply -- --yes
npm run hyperion:pipeline-apply -- --refresh-gates --yes   # after changing ci.gates
```

- The rendered file has one job per app (setup → install → lint → format →
  typecheck → migrations → migrate → test/coverage → coverage gate (+ diff) →
  PR comment → artifacts → build → audit → audit-fix check; matrix and service
  containers when accepted) plus `changes` (affected filter), `style-fix-*`,
  docker (+ hadolint/buildx cache), `docker-publish`, compose-smoke, e2e, iac,
  commitlint, openapi, codeql, dependency-review, secrets, pr-hygiene,
  lighthouse, a11y, bundle-size, `mobile-*`, docs and notify jobs when accepted.
- Triggers: push (+ `v*` tags when publishing), pull_request, `merge_group`
  (unless `merge_group: false`), workflow_dispatch, weekly schedule for
  `audit.fix: pr`. Superseded PR runs are cancelled.
- Secrets the person may need: `HYPERION_PR_TOKEN` (style-fix `commit`,
  audit-fix PRs that trigger CI), `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL`
  (notify). GHCR publish uses `GITHUB_TOKEN`. Never put values in `ci.gates`.
- The coverage gate runs `scripts/hyperion/coverage-gate.mjs` (no deps):
  istanbul json-summary, lcov, cobertura, jacoco, go coverprofile, simplecov;
  diff coverage reads lcov, Cobertura, Go cover or `coverage-final.json`;
  writes a table to the Job Summary (and the PR comment file).
- `hyperion:doctor` flags `hyperion-product-ci.yml` when `ci.gates` changed
  (`gates-hash` mismatch). Add a comment line starting with
  `# hyperion:no-auto-refresh` to the file to keep manual edits — refresh then
  skips it.

If legacy workflows exist and hyperion-* were written:

```bash
npm run hyperion:pipeline-apply -- --yes --migrate-legacy
```

**Never** run `--migrate-legacy` until hyperion replacements exist and user confirms.

## Step 5 — Close the loop

1. Run the accepted gates locally once (`commands` from the scan) so the first
   CI run is not red for a known reason; fix or downgrade to `warn`.
2. List what was accepted, declined (now in `ci.gates.declined`) and deferred
   (CD design items), plus the CI-minute estimate.
3. Process actions confirmed in Step 3 (Dependabot, CODEOWNERS, hooks,
   required checks) — each as its own change.

## Hyperion workflow map

| File | Purpose |
|------|---------|
| `hyperion-sync-cards.yml` | Sync `.github/cards/` → GitHub/Jira |
| `hyperion-security.yml` | npm/pip audit + license check + secret scan |
| `hyperion-validate.yml` | Kit checks (docs, skills, cards tests) |
| `hyperion-product-ci.yml` | Gates from `ci.gates`; minimal lint/test/build when no gates and no product CI |

## Rules

- **Never overwrite** non-`hyperion-` workflow files.
- **Never delete** user CI without explicit approval.
- **Never enable a gate the person did not accept**; declined = `off`.
- Run `pipeline-plan` before `pipeline-apply` — show plan first.
- Secrets/credentials never go in `ci.gates` or the workflow; use repo secrets.
- For GitLab/Azure/Jenkins: set `ci.provider`, `ci.policy: merge`, point to merge doc
  (use the scan + answers as a checklist for their pipeline).
- Delegate card sync details to `cards-sync-setup` when `projects-map.json` needs work.

## See also

- `project-discovery` — persists detected `ci.existing` in Configure mode
- `devops-audit` — reviews existing pipelines (read-only)
- `hyperion-ops` — runs pipeline npm scripts for the user
