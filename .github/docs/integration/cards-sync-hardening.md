# Cards sync hardening — production-grade board ↔ git alignment

This guide closes the remaining operational gaps for cards sync in GitHub-hosted repos.

## Required GitHub settings

### 1. Branch ruleset (recommended over legacy branch protection)

**Settings → Rules → Rulesets → New ruleset**

| Rule | Value |
|------|-------|
| Target | Default branch (`main`) |
| Require status checks | `board-guard` (job name from `hyperion-cards-pr-check.yml`) |
| Require merge queue | Enabled |
| Block force pushes | Enabled |

### 2. Merge Queue

Merge Queue re-runs checks on the merged preview commit before landing on `main`.  
The kit workflow listens to `merge_group` events automatically.

### 3. Secrets

| Secret | Purpose |
|--------|---------|
| `PROJECT_SYNC_TOKEN` | PAT with Issues + Projects (org projects) |

## Workflows (auto-installed by `hyperion:pipeline-apply`)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `hyperion-cards-pr-check.yml` | PR + merge_group | Directional guard on PR branch |
| `hyperion-cards-pr-recheck.yml` | Cron 30min + webhook | Re-validates open PRs (fixes stale green checks) |
| `hyperion-sync-cards.yml` | Push main | pull → guard → push on main |

## Directional guard logic

```
board ≠ HEAD  AND  HEAD == base  →  external drift → FAIL
board ≠ HEAD  AND  HEAD ≠ base  →  forward pending → OK
```

- **PR base** = `pull_request.base.sha` or merge-group base
- **Main base** = `github.event.before` (previous commit on push)

## Optimistic locking: `board_sync_at`

Each card carries an ISO timestamp of the last known board state:

```yaml
board_sync_at: "2026-09-02T13:00:00.000Z"
```

Set automatically on `--reverse` from issue/work item `updatedAt`.  
Included in directional guard field comparison.

## Webhook: invalidate PR checks when board changes

Trigger recheck from Linear/Jira/custom automation:

```bash
curl -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/dispatches \
  -d '{"event_type":"hyperion-board-changed","client_payload":{"base_branch":"main"}}'
```

This runs `hyperion-cards-pr-recheck.yml` and posts updated `board-guard` check runs.

## Environment flags

| Variable | Default in CI | Meaning |
|----------|---------------|---------|
| `CARDS_CI_STRICT_GIT` | `true` | Fail if git diff unavailable (no fail-open) |
| `CARDS_CI_REQUIRE_PROJECT` | `true` (GitHub) | Require `projectNumber` for board field reverse |
| `CARDS_GUARD_BASE_REF` | auto | Override merge-base / parent SHA |
| `CARDS_PR_CHECK_NAME` | `board-guard` | Check run name for recheck workflow |

## Refresh workflows in existing repos

```bash
npm run hyperion:pipeline-apply -- --refresh-sync --yes
```

## Residual limits (honest)

| Limit | Mitigation |
|-------|------------|
| Fork PRs | Validate-only job (no board token) — deliberate, see below |
| Admin bypass merge | Ruleset + audit |
| API lag after forward | Post-forward verify + retry in `ci-sync` |
| GitLab/Azure native webhooks | Use cron recheck on GitHub; MR guard on GitLab/Azure CI |

### Why fork PRs stay validate-only (not a bug)

`hyperion-cards-pr-check.yml`'s real `board-guard` job (and the cron-based
`hyperion-cards-pr-recheck.yml`) both explicitly exclude fork-origin PRs from
board-drift checking. This was considered and rejected as fixable:

Both jobs `actions/checkout` the **PR head SHA** and then execute
`scripts/cards-sync/*.mjs` **from that checkout** — i.e. whatever code is at
that commit, not a trusted copy. For a same-repo PR, that's a branch only a
collaborator with push access could create, so this is an accepted risk.
For a **fork** PR, the head SHA is fully attacker-controlled: if that job ran
with `secrets.PROJECT_SYNC_TOKEN` in its environment (required for a real
board-drift comparison), a malicious fork PR could simply edit
`report-pr-guard-check.mjs` to exfiltrate the secret — the classic GitHub
Actions ["pwn request"](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)
pattern. Giving fork PRs the same board-token access `hyperion-cards-pr-recheck.yml`
gives same-repo PRs would be a real vulnerability, not a fix.

The theoretically-safe version of this check exists (`pull_request_target` +
fetching the PR's *changed file contents* via the read-only API, never
checking out or executing fork-controlled code in the privileged job) but is
enough additional attack-surface and complexity to get subtly wrong that it
isn't worth it for what it buys: fork PRs already get full schema/frontmatter
validation on open, and the `board-guard`/cron recheck catch any real drift
the moment the PR lands on `main` via `merge_group`. A fork PR can be
*stale* relative to the board for the length of its review; it can't merge
without the board-guard passing.
