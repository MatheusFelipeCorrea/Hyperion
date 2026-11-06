# Language policy (repository language and multiple languages)

**Português:** [language-policy.md](./language-policy.md)

Hyperion writes in the language your team uses. You pick it once (setup asks); every agent, script and CI message follows it.

## Configure

```yaml
# .github/project.yml
locale: pt-BR              # primary language — any BCP 47 tag (en, pt-BR, es, fr, de-AT…)
languages: [pt-BR, en]     # optional; primary first; more than one = multilingual
i18n:
  multilingual: [pr, comments, release]   # default; also: docs, issues
```

| Way | How |
|-----|-----|
| Chat | `/setup` or `/discover` — the agent runs `npm run hyperion:detect-language`, suggests a language and asks you to confirm |
| Terminal | `npm run hyperion:setup -- --locale pt-BR --languages pt-BR,en` |
| By hand | Edit `project.yml`; `npm run hyperion:project-verify` validates it |

No `locale` → Hyperion uses `en` and `hyperion:doctor` warns.

## What goes in which language

| What | Language |
|------|----------|
| Chat replies | The person's language |
| Cards, specs, plans, ADRs, memory, audits, reports | Primary (`locale`) |
| PR title/body, PR and review comments, release notes | Primary; extra `languages` in collapsed `<details>` blocks when the surface is in `i18n.multilingual` |
| Commit messages | Conventional type/scope in English + subject in the primary language |
| Code, identifiers, branches, `CARD_ID`, paths, CLI flags | Always English |
| GitHub Actions job and step names | Always English (required checks match them by name) |

Cards stay single-language: the board would otherwise duplicate every title. Add `issues` to `i18n.multilingual` only if your team really wants bilingual cards.

### Commit example

```text
feat(auth): adiciona login com Google
fix(cards): corrige status duplicado no board
```

Type and scope stay in English because changelog tooling, `release` and the PR title gate parse them.

### Multilingual PR example (`languages: [pt-BR, en]`)

```markdown
## Resumo
Adiciona login com Google.

<details><summary>English</summary>

## Summary
Adds Google sign-in.

</details>
```

## Fixed script messages

CI comments, coverage summaries, the board guard and the reconcile report come from message catalogs, not from the agent:

| Catalog | Path |
|---------|------|
| Shipped | `scripts/hyperion/i18n/en.json`, `pt-BR.json`, `es.json` |
| Your override / new language | `.github/i18n/<tag>.json` (same keys as `en.json`) |

Lookup order: exact tag → base language → shipped tag with the same base → `en` (so `pt-PT` uses `pt-BR`, `fr` without a catalog uses English). `hyperion:doctor` lists missing keys.

After changing `locale` or `languages`, regenerate the product CI (`npm run hyperion:pipeline-apply -- --yes`) so its comments use the new language.

## Related

- Runtime rules: Language section in `CLAUDE.md`, `.cursor/rules/hyperion.mdc`, `.github/copilot-instructions.md` (generated from `scripts/hyperion/commands-lib.mjs`)
- Detection: `npm run hyperion:detect-language` (README, recent commits, PR titles)
