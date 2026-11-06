---
name: changelog-generator
description: >-
  Generates or updates a CHANGELOG.md based on git history, conventional commits,
  and merged PRs. Use when the user asks to generate a changelog, prepare release
  notes, or document what changed between versions.
---

# Changelog Generator

Produces a structured changelog from git history using Conventional Commits.

## Step 1 — Determine scope

Ask or infer:
- **Version range** — from which tag/commit to which? (e.g., `v1.2.0..HEAD`)
- **Next version** — what will this release be called?
- If no tags exist, generate the first changelog from all history.

## Step 2 — Collect changes

Read git log for the range. Classify commits by prefix:

| Prefix | Section |
|--------|---------|
| `feat:` | Funcionalidades |
| `fix:` | Correções |
| `refactor:` | Refatorações |
| `perf:` | Performance |
| `docs:` | Documentação |
| `test:` | Testes |
| `chore:` | Manutenção |
| `BREAKING CHANGE` | Quebras de compatibilidade |

## Step 3 — Generate changelog entry

Format:

```markdown
## [{version}] - {YYYY-MM-DD}

### Quebras de compatibilidade
- {description} ({commit hash})

### Funcionalidades
- {description} ({commit hash})

### Correções
- {description} ({commit hash})

### Refatorações
- {description} ({commit hash})

### Performance
- {description} ({commit hash})
```

## Step 4 — Write

- If `CHANGELOG.md` exists, prepend the new entry at the top (after the header).
- If it doesn't exist, create it with a header and the first entry.
- Keep older entries intact.

## Output

| Artifact | Path |
|----------|------|
| Changelog | `CHANGELOG.md` at repository root |
| Release notes (optional) | Same entry prepended to `CHANGELOG.md` |

Prepend new version block after the header; never delete historical entries.

## Rules

- Group by type, not by date
- Remove noise commits (`chore: bump version`, merge commits) unless they carry meaningful info
- Link commit hashes when possible: `[abc1234](../../commit/abc1234)`
- If scope is provided in commits (`feat(auth):`), group by scope within each section
- Breaking changes always go first with clear migration notes
- Output language: primary `locale` from `project.yml`; when `languages` has extras and `release` is in `i18n.multilingual`, add one `<details>` block per extra language (see `.github/docs/meta/language-policy-en.md`)
- Commit subjects may be in any language — classify by the English type/scope (`feat`, `fix`…), not by the subject text

## Example

> "Generate changelog for this release"
> → Reads git log from last tag, classifies 12 commits, generates structured entry,
>   prepends to CHANGELOG.md.
