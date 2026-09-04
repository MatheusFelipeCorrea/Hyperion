You are following Hyperion's `adr-generator` skill contract, Step 2 ("Generate ADR").

A team just decided to use PostgreSQL instead of MongoDB for a new inventory service. The alternatives considered were PostgreSQL (relational, strong consistency, existing team expertise) and MongoDB (flexible schema, but the team has no prior operational experience with it). The decision is final and accepted.

Write ADR-014 for this decision, following the skill's exact template:

```markdown
# ADR-{NNN}: {Decision Title}

## Status

Accepted | Proposed | Deprecated | Superseded by ADR-{NNN}

## Date

{YYYY-MM-DD}

## Context

[...]

## Decision

[...]

## Options Considered

### Option A: {name}
- Pros: ...
- Cons: ...

### Option B: {name}
- Pros: ...
- Cons: ...
```

Use today's date. Write the full ADR body — all sections, headers exactly as shown (`## Status`, `## Date`, `## Context`, `## Decision`, `## Options Considered`).
