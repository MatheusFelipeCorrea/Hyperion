---
name: sprint-retro
description: >-
  Facilitates a sprint retrospective session. Collects what went well, what didn't,
  and action items. Generates a structured retro document. Use when the user asks
  for a retrospective, retro, or sprint review.
---

# Sprint Retro

Facilitates and documents a sprint retrospective.

## Step 1 — Context

Gather:
- Sprint number/name and date range
- Team members involved (if known)
- Goals that were set for this sprint (check cards/issues if available)

## Step 2 — Facilitate the retro

Use the **Start / Stop / Continue** format (or ask if user prefers another):

### What went well? (Continue)
Ask: "What should we keep doing? What worked this sprint?"

### What didn't go well? (Stop)
Ask: "What caused friction? What should we stop or change?"

### What should we try? (Start)
Ask: "What new practices or experiments should we try next sprint?"

## Step 3 — Identify patterns

After collecting input:
- Group related items
- Identify recurring themes from previous retros (check `.github/docs/retros/` if exists)
- Highlight items that appeared before but weren't resolved

## Step 4 — Generate action items

For each "Stop" or "Start" item, create a concrete action:

```markdown
| # | Action Item | Owner | Due | Priority |
|---|------------|-------|-----|----------|
| 1 | {specific action} | {person/team} | {next sprint} | High/Medium/Low |
```

## Output

| Artifact | Path |
|----------|------|
| Retro document | `.github/docs/retros/retro-{sprint}-{date}.md` |
| Optional action cards | `.github/cards/tasks/` (only if user asks to create cards from action items) |

Create `docs/retros/` if missing. Write the retro in the primary `locale` from `.github/project.yml` — the template below is pt-BR; translate headings for other locales.

## Step 5 — Document

Write to `.github/docs/retros/retro-{sprint}-{date}.md`:

```markdown
# Retrospectiva — Sprint {N} ({date range})

## Continue (o que funcionou)
- {item}

## Stop (o que não funcionou)
- {item}

## Start (o que vamos tentar)
- {item}

## Action Items
| # | Ação | Responsável | Prazo | Prioridade |
|---|------|-------------|-------|------------|
| 1 | {action} | {owner} | {date} | {priority} |

## Métricas (se disponíveis)
- Cards completados: X/Y
- Velocity: Z story points
- Bugs encontrados: N
```

## Rules

- Keep it blame-free — focus on process, not people
- Action items must be specific and measurable (not "improve communication")
- Limit to 3-5 action items per retro (focus > quantity)
- Reference previous retro's action items to check follow-through
- Create the `docs/retros/` folder if it doesn't exist
- Output language matches user preference

## Example

> "Let's do a retro of this sprint"
> → Asks structured questions, collects answers, identifies that "unclear requirements"
>   appeared 3 sprints in a row, generates retro doc with focused action items.
