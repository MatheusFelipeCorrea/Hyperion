---
name: pr-writer
description: >-
  Writes and opens a pull request in the repository language: title in
  Conventional Commits form (English type/scope, subject in `locale`), body
  from the repo's PR template or the localized default, extra `languages` as
  collapsed blocks when PRs are multilingual. Use with /pr, "abre o PR",
  "open a PR", "abre el PR".
---

# PR Writer — pull requests in the team's language

## When to use

- The person asks to open / create / draft a PR (`/pr`, "abre o PR pra dev", "open a PR to main")
- After `/execute` finishes a phase and the person wants it reviewed
- Rewriting an existing PR description (`gh pr edit`)

## Context (read first)

1. `.github/project.yml` → `locale`, `languages`, `i18n.multilingual`, `conventions` (branch/PR title patterns), `ci.gates.pr_hygiene`
2. `.github/PULL_REQUEST_TEMPLATE.md` (or `.github/pull_request_template.md`) — when present, its sections win over the default template
3. `git log <base>..HEAD` and `git diff --stat <base>...HEAD` — what actually changed
4. Linked card: `CARD_ID` from the branch name or commits → `.github/cards/**/<CARD_ID>*.md`

Language rules: `.github/docs/meta/language-policy-en.md`.

## Output

| Artifact | Path |
|----------|------|
| PR body draft | `.github/plans/prs/pr-{branch}.md` (kept for `gh pr edit` and re-runs) |
| Pull request | GitHub, via `gh pr create --title … --body-file <draft>` |

## Process

### Step 1 — Resolve languages

| `project.yml` | PR is written in |
|---------------|------------------|
| `locale: pt-BR` only | pt-BR |
| `languages: [pt-BR, en]` and `pr` in `i18n.multilingual` (default) | pt-BR body + one `<details><summary>English</summary>` block |
| `languages: [pt-BR, en]` and `i18n.multilingual` without `pr` | pt-BR only |
| no `locale` | Ask the team language(s) first (`/setup`); do not guess |

### Step 2 — Title

`<type>(<scope>): <subject in the primary language>` — type/scope in English (PR title gate and changelog parse them), subject short and imperative in `locale`. Respect `conventions.pr_title` / `ci.gates.pr_hygiene.title_pattern` when set. The title is never multilingual.

| locale | Example |
|--------|---------|
| en | `feat(auth): add Google sign-in` |
| pt-BR | `feat(auth): adiciona login com Google` |
| es | `feat(auth): agrega inicio de sesión con Google` |

### Step 3 — Body

1. Repo template present → keep its headings and checkboxes, fill them in the primary language. Do not translate the template's own headings.
2. No template → use the localized default (`templates/pr-body.<tag>.md`, fallback: same base language, then `en`).
3. Always include: what changed and why, how it was tested (commands actually run + result), linked card (`Closes #N` / `CARD_ID`), breaking changes.
4. Section headers carry the same emojis as the cards (`card-refiner`), so a reader recognizes them on the board and in the PR (table below). Emojis go in body headers only: never in the title (the PR title gate and changelog parse `type(scope): subject`), commit messages, labels or branch names. A repo template without emojis keeps its own headings.
5. Multilingual → write the full body in the primary language, then append one block per extra language (example below).

| Section | Emoji | Same as the card's | en | pt-BR | es |
|---------|-------|--------------------|----|-------|----|
| Summary | 📋 | `📋 Resumo` | Summary | Resumo | Resumen |
| Changes | 🛠️ | `🛠️ Implementação` | Changes | Mudanças | Cambios |
| Testing | ✅ | `✅ Critérios de Aceite` | How it was tested | Como foi testado | Cómo se probó |
| Linked card | 🔗 | `🔗 Sub-issues` | Linked card | Card vinculado | Tarjeta vinculada |
| Breaking changes | ⚠️ | — | Breaking changes | Quebras de compatibilidade | Cambios incompatibles |

```markdown
<details><summary>English</summary>

## 📋 Summary
...

</details>
```

Translate meaning, not word by word. Code, paths, commands and identifiers stay identical in every block.

### Step 4 — Open

Show the title + body to the person and **wait for approval**. Then:

```bash
gh pr create --base <base> --head <branch> --title "<title>" --body-file .github/plans/prs/pr-<branch>.md
```

Existing PR → `gh pr edit <n> --body-file …`. Return the PR URL as a markdown link.

## Rules

- Never open, push or merge without explicit approval
- Never invent test results — only report commands that ran
- Branch names, `CARD_ID`, labels and CI job names stay in English
- Chat with the person in their language even if the PR language differs
