# ADR-002: Defer a GitHub App auth option for cards-sync (keep PAT)

## Status

Accepted (decision: defer, not do)

## Date

2026-09-03

## Context

`cards-sync`'s GitHub backend authenticates with `GITHUB_TOKEN` (repo-scoped, works for most repository-level Projects) or, when that's insufficient, a fine-grained Personal Access Token saved as the `PROJECT_SYNC_TOKEN` secret (documented in `scripts/cards-sync/README.md` § "Auth and backend variables": `Issues: Read and write`, `Contents: Read`, `Projects: Read and write`). This is a real, working setup used today.

A fine-grained PAT has two structural weaknesses for a team, as opposed to a single maintainer: it's tied to the individual who created it (if they leave, sync breaks and someone has to notice and re-mint it under a new identity), and it has no built-in rotation story — expiry is whatever the creator picked, and nothing in the kit tracks or warns about approaching expiry. A GitHub App, by contrast, authenticates as the app itself (not a person), issues short-lived installation tokens automatically, and survives any one person leaving the team.

## Decision

**Defer building GitHub App support.** No code changes in this ADR. The reason isn't that a GitHub App would be worse — it's that adding it is real, security-sensitive engineering plus at least one action only a repo/org admin can take, and that action wasn't requested as part of this evaluation.

## Options Considered

### Option A: Build GitHub App support now
Register a GitHub App (manifest, permissions matching the current PAT scopes, private key), implement the installation-token exchange (JWT signed with the app's private key → short-lived installation token, refreshed per sync run), and add it as a third auth option alongside `GITHUB_TOKEN`/`PROJECT_SYNC_TOKEN`.
- Pros: no single-person dependency; tokens rotate automatically (~1 hour lifetime, re-issued per run); an org admin can see exactly what the app can access, in one place, instead of trusting whatever scopes a PAT's creator happened to pick.
- Cons: **registering the App is an account/org-level action** — it has to happen in GitHub's UI (or via API with org-owner permissions) by someone with that authority, which a code change alone can't do or fake. The implementation itself (JWT signing, private key handling, installation-token caching/refresh) is meaningfully more code than reading an env var, and is exactly the kind of security-sensitive surface that deserves a real design review, not a solo pass. Getting private key storage wrong (e.g. committed, or logged) would be a worse outcome than the PAT rotation gap this is meant to fix.

### Option B: Defer, document the tradeoff, keep PAT
Leave `GITHUB_TOKEN`/`PROJECT_SYNC_TOKEN` as the only GitHub auth path; record this ADR so the tradeoff is visible instead of silently unconsidered.
- Pros: zero risk; doesn't block anyone using the kit today; the actual registration decision — which org, which permissions, who holds the private key — stays with whoever runs the adopting team, which is where that decision belongs anyway.
- Cons: the rotation/single-person-dependency gap stays open for teams that would benefit from fixing it.

### Option C: Lighter interim step — PAT expiry reminder
Without building App support, have `hyperion:doctor` (or `cards:doctor`) warn when `PROJECT_SYNC_TOKEN` is close to its GitHub-reported expiry (fine-grained PATs expose this via the API), instead of syncing failing silently and someone having to notice.
- Pros: small, code-only, no account-level action needed, real improvement over "sync just breaks one day."
- Cons: doesn't fix the single-person-dependency problem, only the "silent failure" part of it.

## Consequences

### Positive
- No security-sensitive auth code shipped without a deliberate design pass.
- The decision of *whether* a team wants the operational overhead of running a GitHub App (registration, permission review, key custody) stays with that team, not pre-decided by the kit.

### Negative
- Teams relying on `PROJECT_SYNC_TOKEN` still carry the single-person-dependency and manual-rotation risk this ADR describes.

### Risks
- **If deferred indefinitely, the gap never closes.** Mitigation: Option C is a real, code-only next step that doesn't wait on anyone's admin action — worth picking up as its own small piece of work independent of the larger App-auth question.

## References

- `scripts/cards-sync/README.md` § "Auth and backend variables" — current PAT setup.
- [Painel Hyperion](https://claude.ai/code/artifact/65052811-fb21-49b5-b17e-ba184fcb45ee) / [Backlog de fechamento](https://claude.ai/code/artifact/4790a8a3-b263-4322-bff6-8ae6cb619976) — origin of this evaluation (Backlog lane, "Auth").
