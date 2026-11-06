---
name: release-manager
description: >-
  Prepares a semver release: changelog from commits, version bump, tag checklist.
  Used by the release agent (/release) or standalone. Never pushes without user approval.
---

# Release Manager — changelog & version checklist

Skill companion to `release.agent.md`. Use for **partial** release tasks or when the user wants a checklist without full agent orchestration.

## When to use

- "Prepare release 1.2.0"
- "Generate changelog since last tag"
- User invoked `/release` in a runtime without agent support

## Output

| Artifact | Path |
|----------|------|
| Changelog section | `CHANGELOG.md` (root) |
| Release checklist | In-session or `.github/plans/releases/release-{version}-checklist.md` |

## Steps

1. Read `project.yml` → `locale` / `languages` / `i18n.multilingual`, manifest paths (release notes in the primary language; extras as `<details>` when `release` is multilingual)
2. Detect current version from manifest; list tags via git
3. Collect commits since last tag (Conventional Commits)
4. Draft CHANGELOG section (Added/Changed/Fixed/Security)
5. Propose semver bump rationale
6. Output checklist — **do not commit or tag** unless user explicitly asks

## Checklist template

```markdown
## Release vX.Y.Z checklist
- [ ] Tests pass
- [ ] CHANGELOG updated
- [ ] Version bumped in {manifest}
- [ ] No secrets in diff
- [ ] User approved tag message
- [ ] git tag vX.Y.Z && push --tags
- [ ] GitHub Release drafted (optional)
```

## Rules

- Delegate full orchestration to **release** agent when user wants end-to-end `/release`
- Use **changelog-generator** for detailed commit grouping if needed
- Never force-push tags
