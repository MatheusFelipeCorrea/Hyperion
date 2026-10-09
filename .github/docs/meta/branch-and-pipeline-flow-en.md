# Branch, PR and pipeline flow

How code moves through the Hyperion repository: where to branch from, where to send the PR, what each pipeline checks, and what to do when something fails. At the end, what of this reaches (and what does **not** reach) people using Hyperion in their own product.

**Português:** [fluxo-de-branches-e-pipeline.md](./fluxo-de-branches-e-pipeline.md) · Contribution rules: [CONTRIBUTING.md](../../../CONTRIBUTING.md)

---

## In 30 seconds

- You branch from **`dev`** and send the PR to **`dev`**.
- When a batch is ready, the maintainer promotes **`dev` → `qa`**, where the heavy sweep (QA gate) runs.
- Once QA passes, **`qa` → `main`**. `main` is what everyone gets from `git clone` or `hyperion:upgrade`, so it never carries a binding to this repository.
- **`internal`** pulls from `main` on its own and is where Hyperion uses itself (real board, real cards). It never sends anything back.

```mermaid
flowchart LR
  F["feat/* fix/* docs/* ...<br/>(branch or fork)"] -->|PR| D[dev]
  B[Dependabot] -->|PR| D
  D -->|promotion PR<br/>QA gate| Q[qa]
  Q -->|promotion PR| M[main]
  M -->|internal-sync.yml<br/>automatic| I[internal]
```

---

## The branches

| Branch | What it is | Accepts PRs from | Required checks |
|--------|------------|------------------|-----------------|
| `dev` | Integration. All work lands here first. | Any `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/` branch (forks included) and Dependabot | `hyperion-validate` (Ubuntu + Windows) |
| `qa` | Release candidate. | **Only `dev`** from this repository | `hyperion-validate`, `branch-flow`, `qa-gate` |
| `main` | The public version: what `git clone` and `hyperion:upgrade` deliver. Always clean. | **Only `qa`** | `hyperion-validate`, `branch-flow` |
| `internal` | Hyperion using Hyperion: linked board, real cards. | **Only `main`** (`internal-sync.yml` does it) | — |

`branch-flow` rejects any PR out of this order and says where to send it. For example, a PR from `feat/x` into `main` fails with "Merge it into 'dev' first; it reaches main through the dev → qa (QA release gate) → main promotion". A fork's `dev` branch is rejected in `qa` too: only this repository's `dev` promotes.

Nobody pushes directly to `dev`, `qa` or `main`.

---

## Branch conduct

- **Name:** `<type>/<short-description>` with the Conventional Commits type: `feat/board-sprint-filter`, `fix/sync-duplicate-labels`, `docs/pipeline-flow`.
- **Always from an up-to-date `dev`:** `git fetch origin && git switch -c feat/my-change origin/dev`.
- **One topic per PR.** If you find another problem on the way, open another branch.
- **PR title in Conventional Commits** (`feat(cards): ...`, `fix(upgrade): ...`); the body follows the repository template.
- **New code in `scripts/` comes with tests.** QA requires 95% of lines covered, and a file no test imports counts as 0%.
- **No binding to this repository in commits:** GitHub Project number, real cards, plans in `.github/plans/`, personal paths. To test the sync against **your** board, set `PROJECT_NUMBER=<n>` in `.env`. The scripts read it and it never goes into Git. If the purity check flags something, `npm run hyperion:distribution-purity-check -- --fix` cleans it without deleting your files.

---

## A PR's path (contributor)

1. Fork (or branch, if you have access) from `dev`.
2. Before opening the PR, run locally:
   ```bash
   npm test                                   # hyperion + cards tests
   npm run hyperion:distribution-purity-check # no binding to this repo
   npm run docs:check                         # links and translation pairs
   npm run skills:validate                    # if you touched skills
   npm run hyperion:check-rules               # if you touched commands.yml
   ```
3. Open the PR **into `dev`**. `hyperion-validate` runs on Ubuntu and Windows, and `hyperion-security` runs audit, licenses and secrets.
4. If something fails, open the **Checks** tab (or the annotations in **Files changed**). Each failure says what broke, what to do and the command to reproduce it on your machine, pinned to the file when there is one.
5. Review and merge into `dev`. From here on it's the maintainer's job.

Fork PRs run **without secrets** and with a read-only token. Steps that need a token (real board sync, e2e) are skipped, and nothing leaks. First-time contributors need approval before workflows run.

---

## Promotion (maintainer)

### `dev` → `qa`

`gh pr create --base qa --head dev --title "chore(release): promote dev to qa"`

The PR triggers the **QA gate** (`qa-release-gate.yml`), too slow to run on every PR:

| Job | What it guarantees |
|-----|--------------------|
| `tests` | `npm test` + kit tests on Ubuntu, Windows and macOS × Node 22 and 24 |
| `validation` | Every `hyperion-validate` check + **line coverage ≥ 95%** (`npm run kit:coverage`) |
| `install-and-upgrade` | Installs into a new product (`create-hyperion`) and upgrades a product on `main` to the candidate. The product's `project.yml` and workflows must stay byte-identical, and the upgrade must not create workflows. |
| `e2e-cards` | Forward and reverse sync against the sandbox repository (when configured) |
| `workflows-lint` | actionlint + shellcheck on the kit's workflows and product templates |
| `external-links` | External links in every `.md` |
| `secrets-history` | Verified secrets across the full history (trufflehog) |
| `docker` | Image build and smoke test |
| `qa-gate` | Aggregates everything; this is the required check. On failure it names the jobs that broke. |

**Failed?** Don't fix it on `qa`. Fix it in a PR into `dev`; merging it updates the `dev` → `qa` PR and the gate runs again.

### `qa` → `main`

`gh pr create --base main --head qa --title "chore(release): promote qa to main"`. Merge once the checks are green.

### `main` → `internal`

Automatic. On every push to `main`, `internal-sync.yml` tries to merge `main` into `internal`. On a conflict it opens (or reuses) a `main` → `internal` PR to resolve by hand. The `internal` binding to the real board lives only there: the `PROJECT_NUMBER` repository variable and workflows that only exist on that branch.

### Release

A `v*` tag on `main` triggers `hyperion-docker-publish.yml`, which publishes the image.

---

## Every pipeline in this repository

| Workflow | When it runs | What it does |
|----------|--------------|--------------|
| `hyperion-validate.yml` | Push and PR on `dev`, `qa`, `main` | Purity (no binding), `project.yml`, docs (links, pairs, stale wording), skills, generated rules, cards, evals, catalog, `npm test`, dry-run sync — Ubuntu + Windows |
| `hyperion-security.yml` | PR on `dev`, `qa`, `main` + every Monday | `npm audit`, licenses, secrets |
| `branch-flow.yml` | PR on `qa`, `main`, `internal` | The PR comes from the right branch |
| `qa-release-gate.yml` | PR on `qa` | The sweep described above |
| `internal-sync.yml` | Push on `main` | Brings `main` into `internal` |
| `hyperion-docker-publish.yml` | `v*` tag | Publishes the Docker image |
| `hyperion-e2e-cards.yml` | Manual | Sync e2e against the sandbox |
| `hyperion-sync-cards.yml`, `hyperion-cards-pr-check.yml`, `hyperion-cards-pr-recheck.yml` | Manual / PR touching cards / every 30 min | The card pipelines a product would use; here the sync has no push trigger because `main` has no board |

### 95% coverage

`npm run kit:coverage` runs the suite with Node's coverage and adds **every** file in `scripts/hyperion`, `scripts/cards-sync` and `scripts/kit` that no test imports, counting all its lines as uncovered. That way an untested script can't drop out of the count. The output lists the files with the most uncovered lines and how many lines are missing to reach 95%. The live e2e scripts are excluded because they are tests themselves.

This is exclusive to this repository: `scripts/kit/` and the `kit:*` scripts never reach products.

### When a pipeline fails

Every failure becomes a GitHub annotation with a title, the reason, what to do and the command to reproduce it locally, pinned to the file when there is one. Examples:

- `Broken doc link` on `docs/x.md`: "Link target not found: ./y.md".
- `PR into main must come from qa`: tells you to send the PR to `dev`.
- `Kit coverage below 95%`: says how many lines are missing and which files to start with.

---

## In your product (Hyperion users)

None of the above goes into your repository: the 95% gate, `branch-flow`, the QA gate and the kit's workflows belong to the Hyperion repository. `hyperion:upgrade` **does not copy workflows**.

Your product's pipelines come from `/pipeline` (`npm run hyperion:pipeline-apply`), based on `ci.gates` in your `project.yml`:

| Workflow | When it runs | What it does |
|----------|--------------|--------------|
| `hyperion-product-ci.yml` | Push and PR on the main branch | The gates you chose: lint, format, typecheck, tests, coverage, build, audit... |
| `hyperion-sync-cards.yml` | Push on the main branch | Pulls the board → checks for drift → pushes the cards → checks again |
| `hyperion-cards-pr-check.yml` | PR touching `.github/cards/` | Blocks the merge if the board changed outside and the branch doesn't have that change |
| `hyperion-cards-pr-recheck.yml` | Every 30 min | Re-checks open PRs when the board changes |
| `hyperion-security.yml` | PR + weekly | Audit and secrets (optional) |

To update after a kit upgrade:

```bash
npm run hyperion:pipeline-apply -- --refresh-sync --yes    # card pipelines
npm run hyperion:pipeline-apply -- --refresh-gates --yes   # product CI, after changing ci.gates
```

Already have your own CI (GitLab, Azure or a mature `ci.yml`)? See [pipeline-merge-en.md](../integration/pipeline-merge-en.md).
