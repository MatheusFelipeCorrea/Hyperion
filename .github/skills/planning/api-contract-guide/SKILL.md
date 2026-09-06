---
name: api-contract-guide
description: >-
  Defines or reviews a public API's contract — versioning strategy, breaking
  vs. non-breaking change rules, and a deprecation timeline — before or
  after the endpoint ships. Use when the user is designing a new public
  API, adding a field to an existing one, or asks "will this break
  clients?"
---

# API Contract Guide

An API without a written contract has an implicit one anyway — whatever the current response shape happens to be. This skill makes that contract explicit, so "does this change break someone?" has an answer that isn't a guess.

## Step 1 — Context

Read:
- `.github/project.yml` — stack, apps (REST? GraphQL? gRPC? Which app exposes the public surface?)
- The actual current contract if one exists: OpenAPI/Swagger spec, GraphQL schema, protobuf definitions — read the real file, don't infer from route handlers alone
- `.github/memory/DECISIONS.md` — has a versioning scheme already been chosen?

## Step 2 — Classify the change (if reviewing one)

| Change | Breaking? |
|--------|-----------|
| Add optional field/param | No |
| Add new endpoint | No |
| Add enum value (if consumers are expected to handle unknown values) | Usually no — confirm consumers actually tolerate unknown values |
| Remove/rename field, param, or endpoint | Yes |
| Make an optional field required | Yes |
| Change a field's type or semantics | Yes |
| Change error response shape | Yes (clients that parse errors) |
| Tighten validation on existing input | Yes (rejects previously-valid requests) |

When in doubt, treat it as breaking — the cost of an unnecessary version bump is much lower than the cost of a silent break.

## Step 3 — Versioning strategy (if none exists yet)

Pick one and record it as the project's convention (don't re-litigate per endpoint):

- **URI versioning** (`/v1/…`, `/v2/…`) — simplest to reason about, easiest for clients to pin.
- **Header versioning** (`Accept: application/vnd.api+json;version=2`) — keeps URLs stable, harder for clients to notice they're on an old version.
- **Field-level evolution, no version number** — only viable if the team commits hard to the additive-only rules in Step 2 and never makes a breaking change without a new field/endpoint.

## Step 4 — Deprecation timeline (for a breaking change or a version bump)

```markdown
## Deprecating {old version/field}

- **Announced:** {date}
- **Deprecated (still works, warns):** {date} — {how consumers are warned: response header, changelog, email}
- **Removed:** {date, minimum a real notice window — not "next sprint"}
- **Migration guide:** {link or inline steps for consumers}
```

## Output

| Artifact | Path |
|----------|------|
| Contract doc / versioning decision | `.github/docs/api/{name}-contract.md`, or update the project's existing OpenAPI/schema file directly if that's the source of truth |
| Deprecation notice (if applicable) | Same file, or `CHANGELOG.md` under a `### Deprecated` heading |

## Rules

- The spec file (OpenAPI/GraphQL schema/protobuf), if one exists, is the source of truth — a written description that contradicts it is the bug, not the other way around.
- Never call a change "non-breaking" because "no client uses that field today" — that's a traffic-pattern guess, not a contract guarantee, unless the project has real usage analytics to back it up.
- A deprecation with no removal date isn't a deprecation, it's a second permanent version.
- Internal-only APIs (no external consumers) can relax these rules — confirm audience before applying the full breaking-change bar to an endpoint only the same team's frontend calls.

## Example

> "I want to make `email` required on POST /users — is that safe?"
> → Classifies as breaking (Step 2: optional → required). Asks for the versioning scheme in use. Proposes either a `v2` endpoint alongside `v1`, or a deprecation window on `v1` with a migration guide, and writes the plan to `.github/docs/api/users-contract.md`.
