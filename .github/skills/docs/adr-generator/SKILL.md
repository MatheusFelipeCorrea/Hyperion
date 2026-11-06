---
name: adr-generator
description: >-
  Creates Architecture Decision Records (ADRs) when architectural choices are
  made. ADRs are immutable — new decisions create new records with supersedes
  links. Output in .github/docs/adr/ADR-{NNN}.md.
---

# ADR Generator — Architecture Decision Records

## When to use

- When making a technology choice (framework, library, database, hosting)
- When choosing between architectural patterns (monolith vs microservices, REST vs GraphQL)
- When defining conventions that affect the whole project
- When reversing or updating a previous decision

## Context (read first)

1. `.github/docs/adr/` — existing ADRs (check for conflicts or supersedes)
2. `.github/memory/DECISIONS.md` — quick decisions log
3. `.github/memory/PROJECT.md` — project context

## Output

| Artifact | Path |
|----------|------|
| ADR file | `.github/docs/adr/ADR-{NNN}-{slug}.md` |
| Quick log entry (optional) | `.github/memory/DECISIONS.md` for minor decisions |

ADRs are immutable — supersede with a new ADR linking `Superseded by ADR-{NNN}`.

## Process

### Step 1: Identify the decision

Ask:
- What is the architectural question?
- What are the options considered?
- What constraints exist? (team size, budget, timeline, existing tech)
- Who are the stakeholders?

### Step 2: Generate ADR

Determine the next ADR number by checking existing files in `.github/docs/adr/`.

Write `.github/docs/adr/ADR-{NNN}-{slug}.md`:

```markdown
# ADR-{NNN}: {Decision Title}

## Status

Accepted | Proposed | Deprecated | Superseded by ADR-{NNN}

## Date

{YYYY-MM-DD}

## Context

[What is the issue? What forces are at play? What constraints exist?]

## Decision

[What is the change being proposed/made?]

## Options Considered

### Option A: {name}
- Pros: ...
- Cons: ...

### Option B: {name}
- Pros: ...
- Cons: ...

### Option C: {name} (if applicable)
- Pros: ...
- Cons: ...

## Consequences

### Positive
- [benefit 1]
- [benefit 2]

### Negative
- [tradeoff 1]
- [tradeoff 2]

### Risks
- [risk and mitigation]

## References

- [Links to docs, articles, benchmarks]
- [Related ADRs: ADR-{NNN}]
```

### Step 3: Update DECISIONS.md

Add a one-liner to `.github/memory/DECISIONS.md`:

```
| ADR-{NNN} | {date} | {title} | {status} |
```

### Step 4: Handle supersedes

If this decision replaces a previous one:
1. Update the old ADR's status to `Superseded by ADR-{NNN}`
2. Add `Supersedes: ADR-{OLD}` to the new ADR context

## Rules

- ADRs are **immutable** once accepted. To change a decision, create a new ADR.
- Keep ADRs concise. The decision should fit in one sentence.
- Include "Options Considered" — this prevents revisiting the same discussion.
- Date is mandatory — decisions have temporal context.
- Write the ADR in the primary `locale` from `.github/project.yml` (headings included); keep the `ADR-{NNN}` id and status values (Accepted, Proposed…) in English.
- If the decision is small/tactical, suggest adding it to DECISIONS.md instead of a full ADR.
