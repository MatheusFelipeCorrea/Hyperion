<p align="center">
  <img src="./.github/docs/assets/hyperion-banner.png" alt="Hyperion — AI agents for the full dev cycle" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1D4ED8?style=for-the-badge&labelColor=0B1220" alt="MIT"></a>
  <a href="https://github.com/MatheusFelipeCorrea/Hyperion"><img src="https://img.shields.io/badge/repo-Hyperion-2563EB?style=for-the-badge&labelColor=0B1220&logo=github" alt="GitHub"></a>
  <a href="https://github.com/MatheusFelipeCorrea/Hyperion/actions/workflows/hyperion-validate.yml"><img src="https://img.shields.io/github/actions/workflow/status/MatheusFelipeCorrea/Hyperion/hyperion-validate.yml?branch=main&style=for-the-badge&label=validate&labelColor=0B1220" alt="Kit validation"></a>
  <img src="https://img.shields.io/badge/agents-8-F5D76E?style=for-the-badge&labelColor=0B1220" alt="8 agents">
  <img src="https://img.shields.io/badge/skills-35-F5D76E?style=for-the-badge&labelColor=0B1220" alt="35 skills">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cursor-ready-2563EB?style=flat-square&labelColor=111827" alt="Cursor">
  <img src="https://img.shields.io/badge/Claude_Code-ready-2563EB?style=flat-square&labelColor=111827" alt="Claude">
  <img src="https://img.shields.io/badge/Copilot-ready-2563EB?style=flat-square&labelColor=111827" alt="Copilot">
  <img src="https://img.shields.io/badge/boards-GitHub_·_Jira_·_Azure_·_Linear_·_GitLab-94A3B8?style=flat-square&labelColor=0B1220" alt="Boards">
</p>

<p align="center">
  <a href="./GETTING-STARTED.en.md"><img src="https://img.shields.io/badge/▶_Start-GETTING--STARTED-F5D76E?style=for-the-badge&labelColor=0B1220" alt="Start"></a>
  <a href="./.github/docs/reference/skills-catalog.md"><img src="https://img.shields.io/badge/📚_Skills-catalog-2563EB?style=for-the-badge&labelColor=0B1220" alt="Skills"></a>
  <a href="./.github/docs/reference/quick-commands-en.md"><img src="https://img.shields.io/badge/💬_Commands-list-2563EB?style=for-the-badge&labelColor=0B1220" alt="Commands"></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/Português-README-94A3B8?style=for-the-badge&labelColor=0B1220" alt="Português"></a>
</p>

**English** · **Português:** [README.md](./README.md)

---

## Contents

1. [What it is](#what-is-hyperion)
2. [Quick map](#quick-map--where-to-use-it)
3. [Skills by area](#skills-by-area--what-they-do)
4. [Commands](#commands--what-to-type-in-the-chat)
5. [Quickstart](#quickstart)
6. [Study guide](#study-guide)
7. [Compatibility](#compatibility)
8. [npm (optional)](#npm-optional)
9. [Contributing](#contributing)

---

## What is Hyperion?

**Hyperion** is a kit you **copy into your repository**. The AI (Cursor, Claude, Copilot) reads the kit files and follows ready-made recipes, from setup to release.

| Without Hyperion | With Hyperion |
|------------------|---------------|
| You explain the process in the chat every time | You type **`/refine`**, **`/implement`**, **`/execute`** |
| Cards, specs and reviews end up scattered | Artifacts go to standard folders (`.github/cards`, `plans`, `audits`) |
| Board and code don't talk | **`/sync`** pushes cards to GitHub / Jira / Azure / Linear / GitLab |

> It is not a cloud app. It is **Markdown + scripts** in your repo. You talk in the **chat**; the terminal (`npm` / Docker) is optional.

---

## Quick map — where to use it

Five areas. Each one has chat commands and skills behind them.

| | Area | You use it when… | Typical commands |
|---|------|------------------|------------------|
| 🧭 | **Bootstrap** | Turning the kit on, health, CI, board | `/setup` · `/migrate` · `/doctor` · `/pipeline` · `/sync` |
| 📋 | **Planning** | Idea → cards → spec | `/explore` · `/refine` · `/spec` · `/spec-review` |
| ⚡ | **Delivery** | Plan, code, PR | `/implement` · `/execute` · `/pr` · `/pr-review` · `/test-plan` |
| 🔍 | **Quality** | Auditing product / code / ops | `/audit` · `/security` · `/architecture` · `/deps` |
| 📚 | **Docs & release** | Diagrams, ADR, changelog, tag | `/diagram` · `/adr` · `/changelog` · `/release` |

Day-to-day flow:

<p align="center">
  <img src="./.github/docs/assets/hyperion-journey-minimal.png" alt="Copy kit → setup/migrate → doctor → refine → implement → execute" width="720">
</p>

Full flow: [full-flow-en.md](./.github/docs/meta/full-flow-en.md) · Study by level: [learning-path-en.md](./.github/docs/onboarding/learning-path-en.md)

---

## Skills by area — what they do

**Skill** = a short recipe (`SKILL.md`) the AI follows once.  
**Agent** = a long flow (`.agent.md`) that pauses for your approval.

<img src="https://img.shields.io/badge/setup-8_skills-2563EB?style=flat-square&labelColor=0B1220" alt="setup">
<img src="https://img.shields.io/badge/planning-8_skills-2563EB?style=flat-square&labelColor=0B1220" alt="planning">
<img src="https://img.shields.io/badge/quality-13_skills-2563EB?style=flat-square&labelColor=0B1220" alt="quality">
<img src="https://img.shields.io/badge/docs-6_skills-2563EB?style=flat-square&labelColor=0B1220" alt="docs">
<img src="https://img.shields.io/badge/agents-8-F5D76E?style=flat-square&labelColor=0B1220" alt="agents">

### 🧭 Bootstrap / setup

| Skill / agent | Command | What it does |
|---------------|---------|--------------|
| project-startup | `/setup` | Guided setup in a new repo |
| migration *(agent)* | `/migrate` | Adapts the kit to a repo that already has code |
| hyperion-ops | `/doctor` | Kit + cards health (runs scripts) |
| project-discovery | `/discover` | Maps the stack and writes `project.yml` |
| pipeline-architect | `/pipeline` | Hyperion CI adapted to your pipeline |
| cards-sync-setup | `/cards-setup` | Configures sync with the board |
| integration-bridge | `/connect` | Connects Jira / Azure / Linear / GitLab |
| mentoring *(agent)* | `/mentor` | Socratic teaching of the kit / flow |

### 📋 Planning

| Skill | Command | What it does |
|-------|---------|--------------|
| hypothesis-forge | `/explore` | Explores an idea before it becomes a card |
| card-refiner | `/refine` | Idea → epics / features / stories |
| acceptance-spec | `/spec` | Given/When/Then spec |
| project-architect | `/architect` | Greenfield blueprint |
| refactor-guide | `/refactor` | Safe refactor plan |
| api-contract-guide | `/api-contract` | API versioning, breaking changes |
| sprint-retro | `/retro` | Retrospective |

### ⚡ Delivery (agents + skills)

| Skill / agent | Command | What it does |
|---------------|---------|--------------|
| implementation-plan *(agent)* | `/implement` | Phased plan (you approve) |
| implementation-executor *(agent)* | `/execute` | Code + tests for the phase |
| pr-reviewer *(agent)* | `/pr-review` | Reviews an open PR |
| testing-strategy | `/test-plan` | Testing strategy |
| feature-flag-manager | `/feature-flags` | Flag lifecycle: rollout, kill switch, removal |
| spec-review *(agent)* | `/spec-review` | Spec gate before coding |

### 🔍 Quality

| Skill / agent | Command | What it does |
|---------------|---------|--------------|
| full-audit | `/audit` | All 6 dimensions at once |
| audit-runner *(agent)* | `/audit-run` | Orchestrated audit with gates |
| security / architecture / devops / po / ux / code-review | `/security` · `/architecture` · … | Single dimension |
| dependency-health | `/deps` | Outdated / risky dependencies |
| tech-debt-tracker | `/tech-debt` | Debt inventory |
| eng-metrics | `/eng-metrics` | DORA snapshot (deploy, lead time, MTTR) |
| compliance-audit | `/compliance` | LGPD/GDPR technical signals |

### 📚 Docs & release

| Skill / agent | Command | What it does |
|---------------|---------|--------------|
| plantuml-generator | `/diagram` | UML set under `.github/diagrams/` |
| adr-generator | `/adr` | Architecture Decision Record |
| changelog-generator | `/changelog` | CHANGELOG |
| readme-updater | `/readme` | Updates README(s) |
| pr-writer | `/pr` | Opens a PR in the repo language (multilingual if configured) |
| release *(agent)* | `/release` | Changelog + version + tag |

📄 **Full list (when · output · SKILL link):** [skills-catalog.md](./.github/docs/reference/skills-catalog.md)

---

## Commands — what to type in the chat

<img src="https://img.shields.io/badge/prefer-AI_chat-F5D76E?style=flat-square&labelColor=0B1220" alt="chat">
<img src="https://img.shields.io/badge/not-terminal-94A3B8?style=flat-square&labelColor=0B1220" alt="not terminal">

### 🟢 First week (memorize these 6)

| # | In the chat | Result |
|---|-------------|--------|
| 1 | **`/setup`** or **`/migrate`** | Kit wired to your repo |
| 2 | **`/doctor`** | What is missing (gh, token, cards…) |
| 3 | **`/refine`** | Your idea becomes cards |
| 4 | **`/implement`** | Phased plan |
| 5 | **`/execute`** | Code + tests |
| 6 | **`/help`** | Lists the rest |

**New** repo → `/setup`. Repo **with code already** → `/migrate`.  
If `/` does not show up in Cursor, type the phrase: *"Set up Hyperion in this repo"*.

### 🟡 When you need it

| Situation | Command |
|-----------|---------|
| Push cards to the board | `/sync` |
| Spec before coding | `/spec` · `/spec-review` |
| Open a PR | `/pr` |
| Review a PR | `/pr-review` |
| Audit | `/audit` (quick) or `/audit-run` (with gates) |
| Dependencies / release | `/deps` · `/release` |
| Diagrams | `/diagram` |

💬 **Every phrase + npm:** [quick-commands-en.md](./.github/docs/reference/quick-commands-en.md)

---

## Quickstart

```bash
git clone https://github.com/MatheusFelipeCorrea/Hyperion.git
```

| # | Step | Action |
|---|------|--------|
| 1 | **Get** | Clone or ZIP → folder **`Hyperion`** |
| 2 | **Paste** | Put the **whole** folder in `your-product/Hyperion/` |
| 3 | **Install** | Have Node ≥ 20? Inside `Hyperion/`: `npm install` (ajv + js-yaml, the kit's only dependencies). **No Node in the product?** Skip this step; the `./bin/hyperion` wrapper runs through Docker automatically for every command in the next steps. See [node-and-docker-en.md](./.github/docs/meta/node-and-docker-en.md) |
| 4 | **Shims** | At the product root: `npm run hyperion:init --prefix Hyperion -- --adopt` |
| 5 | **Use** | Chat in the **product**: `/setup` or `/migrate` |

🌐 **Language:** `/setup` asks for the repo language (`locale: en`, `pt-BR`, `es`…). With `languages: [en, pt-BR]`, PRs, comments and releases come out in both. Code, branches and the commit type stay in English — see [language-policy-en.md](./.github/docs/meta/language-policy-en.md).

<details>
<summary><strong>📦 Details (Hyperion folder + what stays at the root)</strong></summary>

**Preferred:** don't spread skills/scripts across the product root.

| In `your-product/Hyperion/` | Shims only at the product root |
|-----------------------------|--------------------------------|
| Full kit (`.github/skills`, cards, scripts, `Dockerfile`, …) | `CLAUDE.md`, `.cursor/rules/hyperion.mdc`, `.github/project.yml` with `kit.root: Hyperion` |
| Agent artifacts (cards, plans, audits) | **Optional** `hyperion-*` workflows (`ci.policy: skip` if you already have CI) |

Legacy (still supported): selective copy of `.github/…` at the root — see GETTING-STARTED.

</details>

Step-by-step guide: **[GETTING-STARTED.en.md](./GETTING-STARTED.en.md)**

---

## Study guide

| I want to… | Open |
|------------|------|
| 🚀 Understand it and run it | [GETTING-STARTED.en.md](./GETTING-STARTED.en.md) |
| 📗 Study by level 🟢🟡🔵 | [learning-path-en.md](./.github/docs/onboarding/learning-path-en.md) |
| 🧩 See **every** skill | [skills-catalog.md](./.github/docs/reference/skills-catalog.md) |
| 💬 See **every** command | [quick-commands-en.md](./.github/docs/reference/quick-commands-en.md) |
| ⚠️ Avoid common mistakes | [common-pitfalls-en.md](./.github/docs/troubleshooting/common-pitfalls-en.md) |
| 🗺️ Full index | [.github/docs/README.md](./.github/docs/README.md) |

Later: [GitHub setup](./.github/docs/onboarding/setup-github-en.md) · [adapt a repo](./.github/docs/onboarding/adapt-repo-en.md) · [Node/Docker](./.github/docs/meta/node-and-docker-en.md) · [Definition of Done](./.github/docs/meta/definition-of-done.md)

---

## Compatibility

| Runtime | File in the kit |
|---------|-----------------|
| Cursor | `.cursor/rules/hyperion.mdc` |
| Claude Code | `CLAUDE.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |

---

## npm (optional)

Day to day, the **chat is enough**. Terminal/CI:

```bash
npm run hyperion:doctor
npm run hyperion:setup -- --yes
npm run hyperion:sync
./bin/hyperion doctor
```

[Node/Docker](./.github/docs/meta/node-and-docker-en.md) · [GitHub CLI](./.github/docs/integration/github-cli-setup-en.md)

---

## Contributing

Improvements to the **Hyperion repository**: [CONTRIBUTING.md](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.md) · [Security](./SECURITY.md) · [Support](./SUPPORT.md) · [Changelog](./CHANGELOG.md) · [Roadmap](./ROADMAP.md)

`main` is protected — PRs go through `dev`, never straight to `main`. Full flow (`dev` → `qa` → `main`) in the [branch flow](./CONTRIBUTING.md#fluxo-de-branches) section of CONTRIBUTING.md.

Good first issues: filter by [`good first issue`](https://github.com/MatheusFelipeCorrea/Hyperion/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## License

[MIT](LICENSE)

---

<p align="center">
  <img src="./.github/docs/assets/hyperion-logo.png" alt="Hyperion" width="200">
</p>
