# Project Instructions

These instructions apply to all AI coding agents working in this repository
(GitHub Copilot, Cursor, Claude Code, or any other). They are the project's
coding constitution — do not violate them.

## Bootstrap (always first)

1. Read `.github/project.yml` if it exists — it defines the project contract.
2. Read `.github/memory/PROJECT.md` — project context.
3. Read `.github/memory/DOMAIN.md` — domain model.
4. Read `.github/memory/DECISIONS.md` — existing decisions.
5. If `project.yml` is absent, run the `project-discovery` skill or ask the user.

## Principles

### KISS first, SOLID on refactor, DRY on third occurrence

- Write the simplest solution that satisfies the requirement.
- Apply SOLID patterns during refactoring, not upfront.
- Extract shared code only when the pattern has repeated 3 times.

### Spec before code

- Do not implement without understanding what "done" means.
- Acceptance criteria or a BDD spec must exist before writing logic.
- If neither exists, ask the user or suggest running `card-refiner` or `acceptance-spec`.

### Security is not a phase

- Never commit secrets, tokens, or credentials.
- Never trust external input without validation.
- Apply the principle of least privilege in access control.
- When in doubt, ask before exposing data.

### Decisions are recorded

- If you make or suggest an architectural choice, note it.
- Small decisions: add to `.github/memory/DECISIONS.md`.
- Significant decisions: suggest creating an ADR via `adr-generator`.

## Code Rules

### Commits

Use Conventional Commits:
- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — restructuring without behavior change
- `test:` — adding or fixing tests
- `docs:` — documentation only
- `chore:` — tooling, config, dependencies

### Tests

- Every feature must have tests. Prefer unit tests for logic, integration for flows.
- TDD is encouraged: Red (failing test) → Green (minimal pass) → Refactor.
- Do not skip tests to ship faster.

### Error handling

- Use consistent error patterns across the codebase.
- Errors should be informative (what went wrong, where, what to do).
- Never swallow errors silently.

### File organization

- Follow existing conventions discovered from the codebase.
- When creating new files, reference `project.yml` for paths and existing patterns.
- Never invent a new organizational pattern without checking what exists.
- **Hyperion outputs** — every skill writes to a defined folder (see `.github/docs/meta/onde-ficam-os-outputs.md`):
  - Cards (sync) → `.github/cards/`
  - Specs → `.github/plans/specs/`
  - Plans → `.github/plans/implementations/`
  - Audits → `.github/audits/results/<type>/`
  - ADRs → `.github/docs/adr/`
  - Discoveries → `.github/memory/discoveries/`

## Collaboration Rules

### Human gates

- Never execute code or make breaking changes without explicit permission.
- Present plans before implementing.
- Ask when something is ambiguous or contradictory.

### Language

- Match the user's language for communication.
- Keep technical terms in English (controller, service, hook, middleware, etc.).
- Read `locale` from `project.yml` for generated artifacts.

### Documentation

- Update documentation when behavior changes.
- Prefer diagrams (Mermaid) over long prose for flows.
- Keep READMEs current — use `readme-updater` skill periodically.

## Available Skills

<!-- HYPERION:SKILLS:START -->
Skills live in `.github/skills/` organized by category:

- **planning/** — acceptance-spec, card-refiner, hypothesis-forge, project-architect, refactor-guide, sprint-retro
- **setup/** — cards-sync-setup, hyperion-ops, integration-bridge, memory-capture, pipeline-architect, project-discovery, project-startup, repo-migration
- **quality/** — architecture-audit, code-review, dependency-health, devops-audit, full-audit, po-audit, pr-review, security-audit, tech-debt-tracker, testing-strategy, ux-audit
- **docs/** — adr-generator, changelog-generator, plantuml-generator, readme-updater, release-manager

When the user asks for any of these capabilities, read the corresponding `SKILL.md` and follow its instructions exactly.
<!-- HYPERION:SKILLS:END -->

## Agents

<!-- HYPERION:AGENTS:START -->
- `.github/agents/audit-runner.agent.md` — orchestrated 6-dimension audit (`/audit-run`)
- `.github/agents/implementation-executor.agent.md` — execute approved plan phases (`/execute`)
- `.github/agents/implementation-plan.agent.md` — phased implementation plan (`/implement`)
- `.github/agents/mentoring.agent.md` — for teaching/explaining (`/mentor`)
- `.github/agents/migration.agent.md` — adapt Hyperion to existing repo (`/migrate`)
- `.github/agents/pr-reviewer.agent.md` — review open PR diff + tests (`/pr-review`)
- `.github/agents/release.agent.md` — changelog, version, tag (`/release`)
- `.github/agents/spec-review.agent.md` — gate card/spec before coding (`/spec-review`)

See `.github/agents/README.md` for catalog and recommended flow.
<!-- HYPERION:AGENTS:END -->

When a task maps to an existing skill, suggest using it — **or run npm yourself** via `hyperion-ops` when the user wants sync/doctor without using the terminal.

| Need | Skill / command |
|------|-----------------|
<!-- HYPERION:COMMANDS:START -->
| **Full Hyperion setup** | `project-startup` — or user says `/setup` |
| **Sync / doctor / validate cards** | `hyperion-ops` — runs `npm run hyperion:sync`, `hyperion:doctor` |
| Map repo, create project.yml | `project-discovery` — or user says `/discover` |
| Adapt Hyperion to existing repo | `migration` agent |
| Refine idea into cards | `card-refiner` — or user says `/refine` |
| Problem exploration session | `hypothesis-forge` — or user says `/explore` |
| Given/When/Then spec | `acceptance-spec` — or user says `/spec` |
| Greenfield architecture | `project-architect` — or user says `/architect` |
| Architecture Decision Record | `adr-generator` — or user says `/adr` |
| **Full audit (6 dimensions)** | `full-audit` — or user says `/audit` |
| Security review | `security-audit` — or user says `/security` |
| Dependency audit + outdated | `dependency-health` — or user says `/deps` |
| Architecture review | `architecture-audit` — or user says `/architecture` |
| DevOps review | `devops-audit` — or user says `/devops` |
| Product alignment | `po-audit` — or user says `/po` |
| UX review | `ux-audit` — or user says `/ux` |
| Code review | `code-review` — or user says `/review` |
| Review open PR (diff + tests) | `pr-reviewer` agent |
| Phased implementation plan | `implementation-plan` agent |
| Execute approved plan phase | `implementation-executor` agent |
| Gate card/spec before coding | `spec-review` agent |
| Orchestrated 6-dimension audit | `audit-runner` agent |
| Changelog, version, tag | `release` agent |
| Socratic teaching | `mentoring` agent |
| Safe refactoring guide | `refactor-guide` — or user says `/refactor` |
| Sprint retrospective | `sprint-retro` — or user says `/retro` |
| Testing strategy | `testing-strategy` — or user says `/test-plan` |
| Tech debt inventory | `tech-debt-tracker` — or user says `/tech-debt` |
| Generate CHANGELOG | `changelog-generator` — or user says `/changelog` |
| Jira/Azure/Linear/GitLab bridge | `integration-bridge` — or user says `/connect` |
| Cards sync wizard | `cards-sync-setup` — or user says `/cards-setup` |
| Update README | `readme-updater` — or user says `/readme` |
| PlantUML/Mermaid diagrams | `plantuml-generator` — or user says `/diagram` |
| Adaptive CI/CD setup | `pipeline-architect` — or user says `/pipeline` |
<!-- HYPERION:COMMANDS:END -->

## Evolving cards in conversation

If the user asks to move or update a card (e.g. "mova o card X para Done"):

1. Edit the existing file in `.github/cards/{epics|features|stories|tasks}/` — update `status` or other frontmatter fields
2. Keep `card_id` unchanged
3. Run `npm run hyperion:sync` (or `hyperion-ops` skill)
4. **GitHub:** Project Status column updates. **Jira/other:** status in issue metadata (native board not mapped yet)
5. Allowed status values: Backlog, Functional Refinement, Technical Refinement, In Progress, In Tests, In Revision, Done

See `card-refiner` skill § Card evolution during conversation (status aliases) and § Prototype-first refinement (UX flow).
