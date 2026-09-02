# Common pitfalls and learning gaps

What confuses first-time Hyperion users — and how to avoid it.

**Português:** [armadilhas-comuns.md](../troubleshooting/armadilhas-comuns.md) · **Commands:** [quick-commands-en.md](../reference/quick-commands-en.md)

---

## 1. “Do I need npm all the time?”

**No.** Prefer the agent:

| Instead of… | Say… |
|-------------|------|
| Copying README commands | **`/setup`** — guided full setup |
| `validate` + `sync` manually | **`/sync`** — agent runs `hyperion:sync` |
| Manual diagnostics | **`/doctor`** |

npm remains for CI, power users, and when the agent has no shell.

---

## 1a. “I copied all of `.github/` and product CI broke”

The Hyperion repo ships **`project.yml` with `kit_validation: true`** and **kit-maintainer** workflows. In your product:

1. Start from `project.example.yml` → `project.yml` (or `/setup` / `/migrate`)
2. Do **not** copy kit `.github/workflows/` — run **`/pipeline`**
3. **Merge** `hyperion:*` scripts into your `package.json` — don’t replace the file

Canonical table: [README.md](../../../README.md).

---

## 1b. “I don’t have Node on this laptop”

Scripts stay required (kit differentiator). Without Node ≥ 20:

```bash
./bin/hyperion doctor
./bin/hyperion --docker sync
```

See [node-and-docker-en.md](../meta/node-and-docker-en.md).

---

## 2. Cursor: rules not loading

The kit **includes** `.cursor/rules/hyperion.mdc` in a full clone.

If you copied only `.github/` + `scripts/`:

```bash
npm run hyperion:cursor
```

Or ask `/setup` — bootstrap installs rules automatically.

---

## 3. EXAMPLE cards on the board / sync shows zero

Files under `_examples/` and `CARD.template.md` are **reference only** — never synced.

| Symptom | Likely cause |
|---------|--------------|
| “0 cards to sync” on clean clone | Expected — create cards under `epics/`, etc. |
| EXAMPLE vanished from board after update | Correct — they were samples |
| `--only EXAMPLE-*` does nothing | By design — maintainer flag `--include-samples` only |

---

## 4. Card status vs board column

**Safe mode (GitHub Projects):** existing cards without `status` in frontmatter preserve manual board moves. When the user asks to move a card, the agent must set `status:` and run `/sync`.

Forward sync does **not** auto-update Markdown from board-only moves.

**Reverse (`npm run cards:reverse`):** reads GitHub Project fields and **patches frontmatter only** — card body is preserved. Run after board moves, **before** merging to the default branch.

**CI forward (main):** **pull → verify → push** via `ci-sync.mjs`:
1. **Pull** — reverse in CI (board → workspace)
2. **Verify** — `git diff` on card `.md` files; fails if board diverged from commit (run `cards:reverse` locally and commit)
3. **Push** — forward sync (markdown → board)

Git analogy: `git pull` → check → `git push`. `workflow_dispatch`: `pull-forward` (default), `forward-only` (escape hatch), `reverse` (pull only).

**CI PR (before merge):** `hyperion-cards-pr-check.yml` runs directional `pr-board-guard.mjs`:
- Allows forward-pending PR edits (e.g. `status: Done` while board is still `In Progress`)
- Blocks only **external drift** (board moved, branch did not incorporate)

Mark **Hyperion — Cards PR Board Guard** as a required status check in Branch protection. Fork PRs skip the job (no repo secrets).

Outdated workflow? `npm run hyperion:pipeline-apply -- --refresh-sync --yes`

Outdated workflow? `npm run hyperion:pipeline-apply -- --refresh-sync --yes`

---

## 5. `gh auth login` vs `.env` token

Local dev: `gh auth login`. CI: `GITHUB_TOKEN` or `PROJECT_SYNC_TOKEN`. Org Projects may need a fine-grained PAT.

---

## 6. Too many skills — where to start?

Suggested minimal journey — **not** the 30-skill catalog:

![Minimal Hyperion journey — setup, refine, implement, execute](../assets/hyperion-journey-minimal.png)

| Phase | Command | Goal |
|------|---------|------|
| Bootstrap | `/setup` or `/migrate` | `project.yml` + memory |
| Health | `/doctor` | What’s missing (token, cards, rules) |
| Plan | `/refine` | Idea → cards |
| Execute | `/implement` → `/execute` | Plan + code + **your** repo tests |
| Quality (later) | `/audit` | Read-only reports |

`/help` lists the rest. [quick-commands-en.md](../reference/quick-commands-en.md) covers most usage.

---

## 7. Audit takes long / pauses between dimensions

`full-audit` runs six dimensions with pauses by design. Read-only — reports only in `.github/audits/results/`.

---

## 8. Stale docs vs `hyperion:*`

Some long guides still mention `cards:init` — equivalent to `hyperion:setup`.

**Source of truth:**

1. `.github/commands.yml` — canonical registry
2. `npm run hyperion:help` — generated from the YAML above
3. [quick-commands-en.md](../reference/quick-commands-en.md) — human reference (PT pair available)
4. `CLAUDE.md`, `.cursor/rules/hyperion.mdc`, `copilot-instructions.md` — generated runtime rules
5. Folder map: [organizacao.md](../meta/organizacao.md)

Run `npm run hyperion:check-rules` if shortcuts look inconsistent — CI enforces sync.

---

## 9. Non-GitHub backends

GitHub Projects is fully mature. Jira, Azure, GitLab, and Linear all support `--reverse` (frontmatter patch, body preserved). Native column parity is not identical to GitHub Projects — see [choose-backend-en.md](../integration/choose-backend-en.md) and `/connect`.

---

## 10. Not in the kit yet

| User expects | Current status |
|--------------|----------------|
| Native Cursor slash plugin | Rules file — type `/setup` or the equivalent phrase |
| Full Jira Kanban column sync | Workflow **transitions** when names match; native board depends on the project |
| Video walkthrough | Markdown only |

---

## 11. “I’ve never used agents — where do I start?”

You do not need the architecture. Clone [Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion) → copy the kit → open chat in the repo → **`/setup`** or **`/migrate`**. If the model ignores the slash, say *“Set up Hyperion in this repo”*.

| You meant | Use |
|-----------|-----|
| Wire the kit into an existing repo | `/migrate` |
| Only generate/update `project.yml` | `/discover` |
| Explore a product idea | `/explore` |
| Full greenfield setup | `/setup` |

---

## Ask the agent

- *“Run `/doctor` and tell me what’s missing”*
- *“Cursor rules not working — what do I copy?”*
- *“Why didn’t my card sync to the Project?”*
- *“Difference between project-discovery and `/setup`?”*

`/setup` = full orchestration. `project-discovery` = repo map + `project.yml` only.
