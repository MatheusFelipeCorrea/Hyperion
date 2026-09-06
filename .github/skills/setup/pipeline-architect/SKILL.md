---
name: pipeline-architect
description: >-
  Detects existing CI/CD, configures project.yml ci policy, and installs or
  plans Hyperion workflows without overwriting product pipelines. Generates
  minimal product CI for greenfield repos. Use for /pipeline, "monta CI",
  "configura pipeline", or when setup finds workflow conflicts.
---

# Pipeline Architect — adaptive CI/CD

Hyperion workflows use the **`hyperion-`** prefix and **never overwrite** your
existing `ci.yml`, `deploy.yml`, GitLab CI, Azure Pipelines, etc. when
`ci.policy` is `detect` (default).

## Triggers

| User says | Action |
|-----------|--------|
| `/pipeline` | Run this skill |
| "Monta CI para este projeto" | Run this skill |
| "Não sobrescreve minha pipeline" | Explain detect policy + run detect |
| Greenfield repo sem CI | policy `hyperion-only` or `detect` + apply |

## Output

| Artifact | Path |
|----------|------|
| CI policy (Configure mode) | `.github/project.yml` → `ci:` block |
| Hyperion workflows | `.github/workflows/hyperion-*.yml` |
| Merge guide (merge mode) | Reference `.github/docs/integration/pipeline-merge.md` |

## Step 1 — Detect (always run terminal)

```bash
npm run hyperion:pipeline-detect
npm run hyperion:pipeline-plan
```

Summarize for the user:
- Provider (GitHub Actions, GitLab, Azure, …)
- Stack (node-npm, python, docker, …)
- Existing **product** workflows vs **hyperion-** workflows
- Legacy names (`ci.yml`, `sync-cards.yml`) → recommend migrate

## Step 2 — Choose policy

| Policy | When to use |
|--------|-------------|
| **`detect`** (default) | Repo may already have CI — add only `hyperion-*` |
| **`hyperion-only`** | Greenfield — generate `hyperion-product-ci.yml` if no product CI |
| **`merge`** | Mature CI — document manual job injection, no auto-write |
| **`skip`** | User manages all workflows manually |

Ask if unclear. Write or update `ci:` in `project.yml` (show diff).

### `ci.hyperion` flags

| Flag | Default | Meaning |
|------|---------|---------|
| `cards_sync` | true | `hyperion-sync-cards.yml` |
| `kit_validation` | false | `hyperion-validate.yml` (kit maintainers: true) |
| `security_scan` | true | `hyperion-security.yml` |
| `product_ci` | auto | Generate `hyperion-product-ci.yml` only when no product CI |

## Step 3 — Apply (with user approval)

```bash
npm run hyperion:pipeline-apply -- --yes
```

If legacy workflows exist and hyperion-* were written:

```bash
npm run hyperion:pipeline-apply -- --yes --migrate-legacy
```

**Never** run `--migrate-legacy` until hyperion replacements exist and user confirms.

## Step 4 — Stack-specific guidance

After apply, recommend product CI improvements (read-only suggestions):

| Stack | Typical next steps |
|-------|-------------------|
| Node | Add `lint`, `test`, cache; matrix for monorepo |
| Python | ruff/black, pytest, coverage |
| Docker | build-push job, scan image |
| Existing CI | Add cards-sync job snippet from pipeline-merge.md |

## Hyperion workflow map

| File | Purpose |
|------|---------|
| `hyperion-sync-cards.yml` | Sync `.github/cards/` → GitHub/Jira |
| `hyperion-security.yml` | npm/pip audit + license check + secret scan |
| `hyperion-validate.yml` | Kit checks (docs, skills, cards tests) |
| `hyperion-product-ci.yml` | Minimal lint/test/build when none exists |

## Rules

- **Never overwrite** non-`hyperion-` workflow files.
- **Never delete** user CI without explicit approval.
- Run `pipeline-plan` before `pipeline-apply` — show plan first.
- For GitLab/Azure/Jenkins: set `ci.provider`, `ci.policy: merge`, point to merge doc.
- Delegate card sync details to `cards-sync-setup` when `projects-map.json` needs work.

## See also

- `project-discovery` — persists detected `ci.existing` in Configure mode
- `devops-audit` — reviews existing pipelines (read-only)
- `hyperion-ops` — runs pipeline npm scripts for the user
