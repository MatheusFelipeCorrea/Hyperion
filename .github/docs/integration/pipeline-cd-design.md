# Pipeline CD design — deploy, release, previews (proposal)

**Status:** design only. Nothing in this document is rendered by `hyperion-product-ci.yml` yet.
It records the options so the team can decide before Hyperion grows a `ci.deploy` / `ci.release` block.

`ci.gates` covers continuous integration (quality gates, Docker publish to GHCR).
This document covers what happens **after** the gates pass.

## Signals the scanner already collects

`npm run hyperion:pipeline-gates -- --json` exposes, under `scan.repo`:

| Field | Values | Used for |
|-------|--------|----------|
| `deploy` | vercel, netlify, fly.io, render, app-engine, heroku-style Procfile, serverless, firebase, amplify, cloudflare, helm, kubernetes | Pick a deploy target and its auth model |
| `release` | semantic-release, release-please, changesets, goreleaser | Keep the tool the repo already uses |
| `dockerfiles` | paths + build context | Image-based deploys (GHCR → cluster / PaaS) |
| `iac.terraform` | directories | `plan` on PRs, `apply` behind an environment |

## 1. Deploy environments and OIDC

**Goal:** promote the same artifact through `staging` → `production` with GitHub Environments
(required reviewers, wait timers, branch rules) and no long-lived cloud keys.

| Target | Auth | Notes |
|--------|------|-------|
| AWS | `aws-actions/configure-aws-credentials` + OIDC role | Trust policy scoped to `repo:<owner>/<repo>:environment:<env>` |
| GCP | `google-github-actions/auth` + Workload Identity Federation | Same subject scoping |
| Azure | `azure/login` + federated credential | One credential per environment |
| Vercel / Netlify / Fly / Render | Provider token in an **environment** secret | No OIDC; keep tokens out of repo-level secrets |
| Kubernetes / Helm | OIDC to the cloud, then `kubectl` / `helm upgrade --atomic` | Image tag = commit SHA from `docker-publish` |

**Proposed config sketch (not in the schema yet):**

```yaml
ci:
  deploy:
    target: aws            # detected from scan.repo.deploy when possible
    artifact: image        # image | static | serverless
    environments:
      - name: staging
        on: push           # branch from ci.gates.branches[0]
      - name: production
        on: tag            # v* tags; GitHub Environment with required reviewers
    oidc:
      role: arn:aws:iam::123456789012:role/deploy   # identifiers only, never secrets
```

**Rules:** job-level `permissions: { id-token: write, contents: read }` only on deploy jobs;
`concurrency` per environment with `cancel-in-progress: false`; deploy jobs `needs` every
blocking gate plus `docker-publish`.

## 2. Release automation

| Tool | Fits when | Output |
|------|-----------|--------|
| release-please | Conventional Commits already enforced (`commitlint`, `pr_checks.title`) | Release PR → tag → GitHub Release |
| semantic-release | Fully automatic releases from the default branch | Tag + changelog + npm publish |
| changesets | JS monorepos with independent package versions | Version PR per changeset |
| goreleaser | Go binaries | Multi-platform archives + checksums |

**Recommendation:** release-please by default (reviewable release PR, works for any stack).
Keep whatever `scan.repo.release` reports when present. Tags created by the release job
feed `docker.publish.tags` and the production environment.

## 3. Preview deploys

Per-PR environments for web apps (`scan.apps[].web`):

- Vercel/Netlify: rely on their GitHub apps when installed. Hyperion only documents it.
- Static sites without a PaaS: upload the build as an artifact and comment the link.
- Containers: deploy to a namespace per PR (`pr-<number>`), torn down on `pull_request: closed`.

Fork PRs never get preview credentials (`pull_request`, not `pull_request_target`).

## 4. SonarCloud / SonarQube

Optional `ci.gates.sonar` with `organization` and `projectKey` (identifiers only), token in
`SONAR_TOKEN`. It reuses the coverage reports the app jobs already produce (lcov, Cobertura,
JaCoCo). The quality gate maps to `warn` or `block`. Overlaps with coverage, diff coverage
and CodeQL, so ask which one is the source of truth.

## 5. Mutation testing

Stryker (JS/TS, .NET), mutmut (Python), PIT (JVM). Scheduled weekly and on `workflow_dispatch`
only, `warn` first, scoped to changed files on PRs when the tool supports incremental mode.
Never a default in presets: it is slow and noisy until tuned.

## 6. Supply-chain hardening

- **SHA pinning:** render `uses: owner/action@<sha> # vX.Y.Z` instead of tags. Needs a pinned
  version table in the kit and a Dependabot `github-actions` ecosystem entry so pins stay fresh.
  Proposed flag: `ci.gates.pin_actions: true`.
- **Provenance:** `actions/attest-build-provenance` for published images and release artifacts.
- **SBOM:** `anchore/sbom-action` on `docker-publish`; licenses stay in `hyperion-security.yml`.

## 7. GitLab CI and Azure Pipelines parity

`ci.gates` is provider-neutral; only the renderer is GitHub-specific. A second renderer per
provider would map:

| GitHub Actions | GitLab CI | Azure Pipelines |
|----------------|-----------|-----------------|
| job + `needs` | job + `needs` | job + `dependsOn` |
| `continue-on-error` (warn) | `allow_failure: true` | `continueOnError: true` |
| `services:` | `services:` | `resources.containers` + `services` |
| `strategy.matrix` | `parallel: matrix` | `strategy.matrix` |
| paths filter (`changes` job) | `rules: changes:` | `trigger.paths` / conditions |
| `merge_group` | merge trains | — |
| sticky PR comment | MR note via API | PR thread via REST |

Until then, `ci.policy: merge` plus the scan output is the checklist (see
[pipeline-merge.md](pipeline-merge.md)).

## Rollout proposal

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| 1 | Release-please + SHA pinning flag | One product repo releases from a release PR |
| 2 | `ci.deploy` with GitHub Environments + OIDC (AWS/GCP/Azure) and PaaS tokens | Staging on push, production on tag with reviewers |
| 3 | Preview deploys + SonarCloud (opt-in) | Preview link on PRs for one web app |
| 4 | GitLab renderer, then Azure | Same `ci.gates` renders on both providers |

## Decisions needed

1. Should deploy live in `hyperion-product-ci.yml` or a separate `hyperion-deploy.yml`?
   A separate file keeps CI re-renders from touching production.
2. Default release tool: release-please (recommended) or per-stack choice?
3. Is SHA pinning on by default for new renders?
4. Which provider gets parity first: GitLab or Azure?
