---
name: feature-flag-manager
description: >-
  Plans a feature flag's full lifecycle — naming, rollout stages, kill
  switch, and removal date — before any code ships behind it. Use when the
  user wants to gate a feature behind a flag, plan a gradual rollout, or
  asks "how do we ship this safely?"
---

# Feature Flag Manager

A flag with no removal plan is permanent debt on day one. This skill exists to make the removal plan part of the flag's birth certificate, not an afterthought nobody owns.

## Step 1 — Context

Read:
- `.github/project.yml` — stack, apps, conventions (is there already a flagging library/service in use? LaunchDarkly, Unleash, a homegrown `flags.json`, env vars?)
- `.github/memory/DECISIONS.md` — has flag naming/lifecycle been decided before?
- Existing flags in the codebase (grep for the project's known flag-check pattern) — don't propose a naming scheme that conflicts with what's already there

## Step 2 — Define the flag

For each flag, capture:

```markdown
### {flag_name}

- **Purpose:** {what behavior it gates, one sentence}
- **Type:** Release (temporary, ships to 100% then removed) / Ops (permanent kill switch) / Experiment (A/B, has a data-collection end date) / Permission (long-lived, gates by user segment)
- **Owner:** {who decides when to advance/remove it}
- **Default state:** {on/off, and for whom}
```

Type matters: **Release** and **Experiment** flags MUST get a removal date in Step 3. **Ops** and **Permission** flags are allowed to stay indefinitely — don't force a removal date onto a flag that's meant to be a permanent switch.

## Step 3 — Rollout plan

```markdown
| Stage | Audience | Success signal | Rollback trigger |
|-------|----------|-----------------|-------------------|
| 1. Internal | Team/staff only | No new errors in {monitoring} | Any P1 |
| 2. Canary | {5-10}% of users | {specific metric within bound} | Metric regression |
| 3. Full | 100% | Sustained for {N days} | — |
| 4. Cleanup | — | Flag removed, code path deleted | — |
```

Adjust stage count to the project's actual risk tolerance — a low-traffic internal tool doesn't need a 4-stage canary; a payments path might need more than 4.

## Step 4 — Kill switch and removal date

- **Kill switch:** confirm the flag can be flipped off *without a deploy* (this is the whole point of a flag over a plain conditional). If the project's flagging mechanism requires a deploy to toggle, say so explicitly — it changes the incident-response story.
- **Removal date:** for Release/Experiment flags, set one. "When it feels done" is not a date. Add it to `.github/memory/DECISIONS.md` or a card so it doesn't rely on someone remembering.

## Output

| Artifact | Path |
|----------|------|
| Flag plan | `.github/docs/flags/{flag_name}.md`, or appended to an existing flags registry if the project has one |
| Removal follow-up (optional) | A card via `card-refiner`, type Task, due around the removal date |

## Rules

- Never propose a Release/Experiment flag without a removal date and an owner.
- Don't invent a flagging library the project doesn't already use — ask, or default to the simplest mechanism that fits (env var, config file, existing service).
- A flag gating two mutually-exclusive code paths is a real fork, not a toggle — call that out; it usually means the "old" path needs its own explicit sunset plan too.
- Kill switches must not depend on the same deploy pipeline they're meant to bypass in an incident.

## Example

> "Gate the new checkout flow behind a flag."
> → Asks: temporary rollout or permanent switch? → Release flag, owner = user, 4-stage canary plan, removal date = 3 weeks after stage 3 holds, writes `.github/docs/flags/new-checkout.md`, offers a removal-reminder card.
