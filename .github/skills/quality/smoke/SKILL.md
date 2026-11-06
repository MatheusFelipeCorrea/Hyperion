---
name: smoke
description: >-
  Boots the real app and exercises the story's BDD scenarios, reporting pass,
  fail, or not-verifiable with evidence. Reports only — does not fix. Use for
  /smoke, "smoke test", or "sobe a app e exercita a spec".
---

# Smoke

Execution sensor between `/review` and `/retro`. Boot the real application, walk the story's scenarios, and record what actually happened.

## Process guard (mandatory first)

```bash
npm run hyperion:process-guard -- --check smoke
```

Exit **2** → pending-sync without BDD spec. **Stop**; do not boot the app. Point at `/spec` / acceptance scenarios for the card, then retry.

`/smoke` **reports. It does not fix.** A bug found here is a new cycle (`/implement` or `/execute`), not an edit made during the smoke.

Usage: `/smoke {story-id}` (a `card_id` or the spec folder name).

## Step 1 — Context

Read `locale` from `.github/project.yml`. The chat summary follows the person's language. The report follows `locale` (default `en` when unset).

Read:

1. `.github/plans/specs/{story-id}/` — the BDD spec (`spec.md` or `*.bdd.md`; Given/When/Then or Dado/Quando/Então)
2. The card under `.github/cards/` with that `card_id`, when it exists
3. `.github/project.yml` — `commands.*` (how to start the app), apps, stack
4. The app entry: `package.json` scripts, Makefile, `docker-compose`, or the equivalent the manifest actually has

If an implementation plan for this card exists under `.github/plans/implementations/` and its verification is not PASS, say so and do not treat the smoke as a sign-off. Point at `/execute`. Still run the smoke when the person asks to see the running app anyway, and mark the report `plan verification was not PASS`.

## Step 2 — What can actually be smoked

Decide the target before launching anything:

- **web** — a servable frontend (`dev`/`start`, a web framework, a served `index.html`). Evidence is a screenshot.
- **api** — an HTTP service. Evidence is status code plus response shape.
- **hybrid** — both. Run both strategies.
- **none** — a library, a CLI with no server, or a content/scripts repo (the Hyperion kit itself is `none`).

`none` is a legitimate result, not a failure. Stop, explain why there is nothing to boot, and point at `/retro`. Do not invent a server.

## Step 3 — Steps and assertion class

1. **From the spec.** For each scenario, turn Given/When/Then into an executable step (navigation plus assertion for web; request plus status/shape for api). If the spec has no scenarios, say so and do only the exploratory pass.
2. **Exploratory pass.** Does the app boot? Does home or health respond? Anything obvious in the boot log?
3. **Assertion class.** This decides what evidence is enough.

| Class | The Then is about… | Enough evidence |
|-------|--------------------|-----------------|
| **visual** | color, background, layout, position, overlap, visible/hidden, contrast, badge, icon | A screenshot that shows the asserted element |
| **textual** | text present, a displayed value, a section absent in the DOM | A DOM read, with the basis named in the report |

When a Then mentions any appearance attribute, it is **visual**. Extra evidence never invalidates a scenario. Missing evidence has approved scenarios that were not working.

## Step 4 — Run it

**Web.** Start the app and walk the capture ladder. Start at rung 1 when a login session must be kept; otherwise start at rung 2. Stop at the first rung that writes a file to disk.

| # | Rung | When | Where it writes |
|---|------|------|-----------------|
| 1 | Browser already open in the IDE | Needs a rendered browser surface; keeps cookies | Usually a temp dir — moving the file is mandatory (Step 5) |
| 2 | Playwright, Puppeteer, or Cypress already in the project | No display required | `page.screenshot` straight to the smoke path |
| 3 | `chrome`, `chromium`, or `msedge` with `--headless --screenshot=<path>` | No project runner, no display required | Straight to the smoke path. Quote the path. Never interpolate a raw scenario title into the shell command |

A failed rung is a reason to try the next one. Stopping is legitimate only after the ladder is exhausted, and every attempted rung goes in the report with why it failed. A screenshot tool that needs a rendered tab cannot see a headless session; a DOM read still can.

**A file on disk is not yet valid evidence.** Rung 2 and 3 do not carry the user's session and may photograph a login wall. Describe only the asserted element ("red badge 'Over limit' visible on the card"). Do not transcribe the whole screen, tokens, credentials, or personal data. If the image does not show the asserted element, the scenario is `not-verifiable`.

**API.** Start the service. For each scenario, call the endpoint and assert HTTP status and response shape. The screenshot ladder does not apply. No scenario is `not-verifiable` merely because there is no image.

If the app does not boot (port in use, missing dependency, crash), that scenario is **failed** with the observed cause. Finish the report. Do not throw past it.

## Step 5 — Report

Write under `.github/plans/specs/{story-id}/smoke/`:

- Screenshots: `scenario-{NN}-{slug}.png`. A capture left in a temp directory does not count until it is copied here. If the move fails, the scenario is `not-verifiable`.
- `report.md` — one row per scenario, the exploratory pass, the target type, and which ladder rung produced each image (or why each rung failed).

| Status | When |
|--------|------|
| `passed` | Visual assertion with a valid screenshot, or textual assertion with the DOM basis named |
| `failed` | The app behaved wrong |
| `not-verifiable` | Could not observe: visual scenario without a valid screenshot, ladder exhausted, or move failed. Never mark this `passed` |

Before finishing, check that every file the report names exists on disk. A report that cites a missing file is a smoke problem, and it says so.

Then summarize:

```
Smoke — {story-id}  (target: web | api | hybrid | none)

Passed: N/M
Failed: K            [the app behaved wrong]
Not verifiable: J    [could not observe — not an app defect]
Screenshots: N/M visual scenarios · rung: {1 open browser | 2 project runner | 3 headless chrome | none}
Evidence: .github/plans/specs/{story-id}/smoke/

Status: app {boots and responds | failed scenarios | not executable}
```

Count `failed` and `not verifiable` separately. A web target that ends at `Screenshots: 0/M` is a declared degradation. Say that. Do not present "it booted" as success. Booted is not seen.

## Output

| Artifact | Path |
|----------|------|
| Smoke report | `.github/plans/specs/{story-id}/smoke/report.md` |
| Screenshots | `.github/plans/specs/{story-id}/smoke/scenario-{NN}-{slug}.png` |

## Rules

- **Report, don't fix.** Record the bug. The fix is a later `/implement` or `/execute`.
- **Missing screenshot does not crash the command and does not pass the scenario.** Visual scenarios without visual evidence stay `not-verifiable`, with the reason.
- **`none` is honest.** Do not force a run where there is no app. Explain and point at `/retro`.
- **Not a code review and not a pentest.** Smoke asks "is it up and does it behave?". `/review` reads the diff. `/security` hunts vulnerabilities.
- **Screenshots can contain real data.** Run against local/dev with test data. Describe only the asserted element in `report.md`. Do not copy tokens or personal data from the image into the markdown.
- **Check gitignore before capturing.** Do not assume. The kit ignores `.github/plans/specs/*`, so in a kit checkout neither the report nor the images are committed. In a product, confirm whether `smoke/*.{png,jpg,jpeg,webp,gif}` is ignored. If images are not ignored, say so in the report: they will enter the next commit. Only `report.md` is meant to be versioned. Do not edit `.gitignore` unless the person asks.
- **Close the loop.** When the run is done, or the target is `none`, point at `/retro`.

## Example

> `/smoke PAY-104`
> → Spec has two scenarios. The Then of the first mentions a red badge, so it is visual. `npm run dev` boots. Playwright is a devDependency, so rung 2 writes `scenario-01-over-limit.png` showing the badge. The second scenario checks a total in the DOM. Report: 2/2 passed, rung 2. Summary points at `/retro`.
