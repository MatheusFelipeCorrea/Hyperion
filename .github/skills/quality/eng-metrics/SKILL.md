---
name: eng-metrics
description: >-
  Measures the 4 DORA metrics (deployment frequency, lead time for changes,
  change failure rate, time to restore) from git/CI history that already
  exists — no new dashboard, no new service. Use when the user asks "how's
  our delivery performance?" or wants a DORA snapshot.
---

# Engineering Metrics (DORA)

The four DORA metrics are usually knowable from data a repo already has — git history and CI run history — without standing up a new tool. This skill computes them from what's there and is explicit about what it couldn't measure, rather than inventing a number.

## Step 1 — Context

Read:
- `.github/project.yml` — `commands.*` (test/build), CI provider, `apps.*` (which app's deploys count?)
- The project's actual deploy signal: a `deploy` GitHub Action, a tag pattern (`v*`), a `CHANGELOG.md` release cadence, or ask the user directly what "a deploy" means here if none of these are obvious
- Time window: default last 90 days unless the user specifies otherwise

## Step 2 — Compute what's measurable from git/CI alone

| Metric | Source | How |
|--------|--------|-----|
| **Deployment frequency** | Deploy tags/releases, or merges to the deploy branch if no tags exist | Count deploys ÷ window, bucket into DORA bands (multiple/day, weekly, monthly, <monthly) |
| **Lead time for changes** | `git log` per commit: time from first commit on a PR branch to that PR's merge (or to deploy tag, if deploy ≠ merge) | Median, not mean — a few long-tail PRs skew the average badly |
| **Change failure rate** | Reverts (`git log --grep=Revert`), hotfix-pattern branches/tags, or failed-then-fixed deploy pairs if CI history distinguishes them | (deploys needing a fix) ÷ (total deploys) |
| **Time to restore** | Time between a failing deploy signal and the next successful one for the same target | Only computable if the project has some evidence of "deploy failed" (a rollback tag, an incident doc, a hotfix commit) |

## Step 3 — Report band, not judgment

DORA's own published bands (Elite/High/Medium/Low) exist for context, not to shame a small team into "Elite" — a 3-person internal tool doesn't need daily deploys to be healthy. State the band, then say plainly whether that's a problem *for this project's actual goals*, not against an abstract ideal.

## Step 4 — Be honest about gaps

If change failure rate or time to restore can't be computed (no revert/incident signal in the data), say so explicitly instead of guessing or omitting silently:

```markdown
**Change failure rate:** Not computable — no revert pattern, hotfix branch convention, or incident log found. To measure this, the team would need to adopt one of: a `hotfix/*` branch naming convention, revert commits with `Revert:` prefix, or a lightweight incident log.
```

## Output

| Artifact | Path |
|----------|------|
| DORA snapshot | `.github/audits/results/_summary/eng-metrics-{date}.md` |

```markdown
# Engineering Metrics — {date}

Window: last {N} days

| Metric | Value | Band | Confidence |
|--------|-------|------|------------|
| Deployment frequency | {value} | {band} | High/Medium/Low |
| Lead time for changes | {median} | {band} | High/Medium/Low |
| Change failure rate | {value or "Not computable"} | {band or —} | — |
| Time to restore | {value or "Not computable"} | {band or —} | — |

## What would improve confidence
- {e.g. "Adopt a consistent deploy-tag convention"}
```

## Rules

- Never fabricate a number for a metric with no real data source — report "Not computable" and what signal would make it computable.
- Median over mean for lead time and time-to-restore — both are heavy-tailed by nature.
- Don't compare across projects/teams without the same measurement method; DORA bands are for trend and self-comparison, not a leaderboard.
- Re-running this later should show a trend, not just a new snapshot — mention the previous snapshot's numbers if `.github/audits/results/_summary/` has an earlier `eng-metrics-*.md`.

## Example

> "How's our delivery performance this quarter?"
> → Finds 47 merges to main, 12 version tags in 90 days (deployment frequency: weekly, "High" band). Computes median PR lead time: 1.8 days. Finds 2 commits matching `Revert:` out of 12 deploys (change failure rate: ~17%). No incident log exists, so time to restore is reported as not computable with a concrete suggestion.
