# 🚀 Getting Started — Hyperion

<p align="center">
  <img src="./.github/docs/assets/hyperion-logo.png" alt="Hyperion" width="180">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/🟢-beginner-22C55E?style=flat-square&labelColor=0B1220" alt="beginner">
  <img src="https://img.shields.io/badge/chat-not_terminal-F5D76E?style=flat-square&labelColor=0B1220" alt="chat">
  <img src="https://img.shields.io/badge/6_commands-first_week-2563EB?style=flat-square&labelColor=0B1220" alt="6">
</p>

**English** · **Português:** [GETTING-STARTED.md](./GETTING-STARTED.md)

From zero (or a legacy repo) to the first release. **You don't need to know what an "agent" is.** On day one, stop at the **6 commands**; the rest can wait.

### What Hyperion does (in one sentence)

You copy the kit into **your** repo → talk to the AI in the chat (`/setup`, `/refine`, `/execute`…) → it follows ready-made recipes and writes cards, plans and audits to standard folders. Optionally **`/sync`** updates the board.

| Area | Chat examples |
|------|---------------|
| 🧭 Turn the kit on | `/setup` · `/migrate` · `/doctor` |
| 📋 Plan | `/refine` · `/spec` · `/explore` |
| ⚡ Deliver | `/implement` · `/execute` · `/pr` · `/pr-review` |
| 🔍 Quality | `/audit` · `/deps` |
| 📚 Docs / release | `/diagram` · `/release` |

Overview + catalog: [README.en.md](./README.en.md) · [skills-catalog.md](./.github/docs/reference/skills-catalog.md)

| Level | You | Start here |
|-------|-----|------------|
| 🟢 **Beginner** | First time with AI in the repo | [Two paths](#two-paths-dont-read-all-30-skills) → 6 commands |
| 🟡 **Intermediate** | Already use Cursor/Copilot | Steps 1–4 + [setup-github-en](./.github/docs/onboarding/setup-github-en.md) |
| 🔵 **Advanced** | Multi-app, CI, several boards | [catalog](./.github/docs/reference/skills-catalog.md) · [commands](./.github/docs/reference/quick-commands-en.md) · [flow](./.github/docs/meta/full-flow-en.md) |

**Learning path:** [learning-path-en.md](./.github/docs/onboarding/learning-path-en.md) · **Flow:** [full-flow-en.md](./.github/docs/meta/full-flow-en.md)

---

## 📖 Words you will see in the kit

| Term | What it means in practice |
|------|---------------------------|
| **Assistant / agent** | The AI chat (Cursor, Copilot, Claude Code). You talk; it reads the kit. |
| **Command** (`/setup`) | You **type it in the chat**, not in the terminal. It is a shortcut to a recipe. |
| **Skill** | A short recipe (`SKILL.md`) the AI follows once. |
| **Agent** (`.agent.md` file) | A **long** recipe that pauses for your approval. |
| **npm** (`hyperion:*`) | Optional. For CI and people who prefer the terminal. |

If the slash command does not show up in Cursor, type the phrase: *"Set up Hyperion in this repo"*.

---

## 🎯 Two paths (don't read all 30 skills)

### 🟢 Never used agents / first time with Hyperion

Memorize **6 commands**. The rest exists; ignore it until you need it.

| Order | In the chat | What happens |
|-------|-------------|--------------|
| 1 | **`/setup`** or **`/migrate`** | Wires the kit to the repo (`project.yml`) |
| 2 | **`/doctor`** | Says what is missing (gh, token, cards) |
| 3 | **`/refine`** | Your idea becomes cards |
| 4 | **`/implement`** | Phased plan (you approve) |
| 5 | **`/execute`** | Code + tests of **your** repo |
| 6 | **`/help`** | Lists the rest whenever you want |

Repo **with code already** → `/migrate`. **New** repo → `/setup`.

![Minimal journey — 6 steps](./.github/docs/assets/hyperion-journey-minimal.png)

### 🔵 I already use agents every day

- [skills-catalog.md](./.github/docs/reference/skills-catalog.md) · [quick-commands-en.md](./.github/docs/reference/quick-commands-en.md) · [full-flow-en.md](./.github/docs/meta/full-flow-en.md)

---

## 📦 1 — Copy the kit

**Official repository:** [https://github.com/MatheusFelipeCorrea/Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion)

```bash
git clone https://github.com/MatheusFelipeCorrea/Hyperion.git
```

### Preferred — `Hyperion/` folder in the product (keeps the root clean)

**One command** (if you already have a Hyperion clone at hand): inside the clone,

```bash
node scripts/hyperion/create-hyperion.mjs /path/to/your-product --yes
```

This copies the whole kit into `your-product/Hyperion/` (skipping `.git`, `node_modules` and runtime outputs such as `plans/` and `audits/results/`), runs `npm install` inside `Hyperion/`, and writes the shims at the product root — steps 1–4 below, automated. Without `--yes` it only shows the preview (dry run). `--repo owner/name` fetches the kit straight from GitHub instead of using the local clone.

Manual, step by step (what the command above does for you):

1. Clone/ZIP → folder named **`Hyperion`**.
2. Put it in `your-product/Hyperion/` (whole kit: `.github`, `scripts`, `Dockerfile`, …).
3. Install the kit dependencies — inside `Hyperion/`:

```bash
cd Hyperion && npm install && cd ..
```

(ajv + js-yaml, the kit's only dependencies, used to validate `project.yml`. Skipping this step breaks `hyperion:project-verify` and `/setup` with a `Cannot find package 'ajv'` error.)

4. At the **product root**:

```bash
npm run hyperion:init --prefix Hyperion -- --adopt
```

This writes shims (`CLAUDE.md`, `.cursor/rules/hyperion.mdc`, `.github/project.yml` with `kit.root: Hyperion`) and does **not** spread skills across the root.

5. Open the chat in the **product** → **`/setup`** or **`/migrate`**.

Cards and plans live under `Hyperion/.github/…`. Already have your own CI? Use `ci.policy: skip` (or skip `/pipeline`) — Hyperion does not require the kit pipeline.

### Legacy — selective copy at the root (still works)

Copy to the **root of your repository** (not Hyperion's `.git`):

| Copy | Don't copy / careful |
|------|----------------------|
| `.github/skills/`, `agents/`, `docs/`, `audits/`, `commands.yml`, `memory/` (templates), `cards/` (template + clean config), `diagrams/`, `project.example.yml`, `project.schema.json`, `hyperion-origin.json` | Hyperion's own **`.github/project.yml`** → use `project.example.yml` or `/setup` |
| `scripts/` | **`.github/workflows/`** → **`/pipeline`** in your repo (or `ci.policy: skip`) |
| `hyperion:*` / `cards:*` scripts in **your** `package.json` (**merge**) | Replacing the product `package.json` |
| `bin/` + `Dockerfile` (no Node) | Another team's `projects-map` |
| `.env.example`, `CLAUDE.md`, `.cursor/rules/`, `.github/copilot-instructions.md` depending on the IDE | Generated artifacts (`plans/`, audit results) |
| — | **`CODEOWNERS`, `.github/FUNDING.yml`, `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`** — files of the Hyperion kit repository itself, not of your product. If you cloned the whole repo (instead of a selective copy), replace or remove them. |

Don't rely on memory for that list — after copying, run `npm run hyperion:adopt-check` (or `hyperion adopt-check` via CLI/Docker): it scans those files and fails if any still carries Hyperion's own identity (maintainer username, "Hyperion Contributors" in LICENSE, etc.).

Updating a repo that already has the kit: `npm run hyperion:upgrade` (in the kit folder / with `kit.root`).

No Node: [node-and-docker-en.md](./.github/docs/meta/node-and-docker-en.md). Gates: [definition-of-done.md](./.github/docs/meta/definition-of-done.md).

---

## ⚙️ 2 — Configure (adapts to the repo)

### Legacy repo (already has code)

> **`/migrate`** — or *"Adapt Hyperion to this repo"*

The agent detects stack, CI and tests and writes `project.yml` with a `commands:` block adapted to the repo.

### New repo or full setup

> **`/setup`** — or *"Set up Hyperion in this repo"*

### Repo language

`/setup` and `/migrate` ask which language the team works in and suggest one from the README and the commits. From the terminal:

```bash
npm run hyperion:detect-language
npm run hyperion:setup -- --locale en --languages en,pt-BR
```

`locale` is the primary language (cards, docs, CI messages). With more than one entry in `languages`, PRs, comments and releases come out in all of them. Rules: [language-policy-en.md](./.github/docs/meta/language-policy-en.md).

### Detect the repo commands (advanced / terminal)

```bash
npm run hyperion:repo-detect
npm run hyperion:repo-detect -- --json
```

This suggests `commands.test`, `commands.lint`, etc. to paste into `project.yml`.

### GitHub CLI (only for card sync on GitHub)

```bash
gh auth login
npm run hyperion:setup -- --yes
```

No GitHub Projects? Skip this. Jira/Linear/Azure/GitLab: [choose-backend-en.md](./.github/docs/integration/choose-backend-en.md) — not step 1.

---

## 📝 3 — First card

> **`/refine`** → **`/sync`**

Cards live in `.github/cards/` — full GitHub support; Jira/Azure/GitLab/Linear with `--reverse`.

---

## 🚢 4 — Delivery (plan → code → tests → PR)

| Step | Command |
|------|---------|
| Spec gate (optional the first time) | **`/spec-review`** |
| Phased plan | **`/implement`** |
| Run a phase (+ repo tests) | **`/execute`** |
| Open the PR (repo language) | **`/pr`** |
| Review the PR | **`/pr-review`** |

Tests use `commands.test` from **your** `project.yml` — nothing hardcoded.

---

## 🔍 5 — Quality and release (when the team asks)

| Step | Command |
|------|---------|
| Orchestrated audit | **`/audit-run`** |
| Quick audit (skill, no agent) | **`/audit`** |
| Dependency health | **`/deps`** |
| Release | **`/release`** |

`/audit` and `/audit-run` cover the **same 6 dimensions**. Use `/audit` day to day; `/audit-run` when you want the long flow with gates.

---

## 🗺️ Full journey (not day one)

```text
/migrate or /setup → /refine → /spec → /spec-review → /implement → /execute
  → /pr → /pr-review → /audit-run → /deps → /release
```

![Hyperion journey](./.github/docs/assets/hyperion-journey-full.png)

---

## 🎛️ Agent vs npm vs CI

| Situation | Use |
|-----------|-----|
| First week | **`/setup`** or **`/migrate`**, **`/refine`**, **`/execute`** |
| Day to day with AI | **`/sync`**, **`/pr`**, **`/pr-review`**, **`/help`** |
| Debug / power users | **npm** — `hyperion:*`, `cards:*` |
| Kit validation | **CI** — `hyperion-validate.yml` |

---

## ⚠️ Problems?

| Symptom | Fix |
|---------|-----|
| Confusing legacy repo | **`/migrate`** |
| Tests fail in the executor | Edit `commands.test` in `project.yml` |
| Cursor rules | `npm run hyperion:cursor` |
| Output in the wrong language | Set `locale` / `languages` in `project.yml` (`npm run hyperion:doctor` shows the current value) |
| Don't know what to type in the chat | **`/help`** or [common-pitfalls-en.md](./.github/docs/troubleshooting/common-pitfalls-en.md) |

---

## ➡️ Next steps

| Want to learn | Read |
|---------------|------|
| Learning path | [learning-path-en.md](./.github/docs/onboarding/learning-path-en.md) |
| **Which skill to use** | [skills-catalog.md](./.github/docs/reference/skills-catalog.md) |
| GitHub setup | [setup-github-en.md](./.github/docs/onboarding/setup-github-en.md) |
| Adapt a repo | [adapt-repo-en.md](./.github/docs/onboarding/adapt-repo-en.md) |
| Index | [docs/README.md](./.github/docs/README.md) |
