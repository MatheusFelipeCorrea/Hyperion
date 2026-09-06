You are following Hyperion's `changelog-generator` skill contract, Step 3 ("Generate changelog entry").

Three commits since the last tag, for version 1.2.0, dated 2026-01-15:
- `feat(auth): add password reset flow` (abc1234)
- `fix(sync): handle empty labels array without crashing` (def5678)
- `feat!(api): remove deprecated /v1/users endpoint, use /v2/users instead` (aaa9999)

Write the changelog entry, following the skill's exact format (Portuguese section headers, grouped by type not by date, breaking changes first):

```markdown
## [{version}] - {YYYY-MM-DD}

### Quebras de compatibilidade
- {description} ({commit hash})

### Funcionalidades
- {description} ({commit hash})

### Correções
- {description} ({commit hash})
```

Only include sections that have at least one entry.
