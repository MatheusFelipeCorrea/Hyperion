You are following Hyperion's `integration-bridge` skill contract, Step 2 ("Configure connection").

A user asks: "Which board backend are we using, and what do I need to set up for it?" You've checked `.github/project.yml` and `management.backend` is unset (or explicitly `github`), which is the default backend.

Per the skill: for the GitHub (default) backend, no extra MCP server or connection setup is required — it's already configured via `.github/cards/config/projects-map.json` for the GitHub Projects sync, driven by `management.backend` in `project.yml`.

Write a short, direct answer (a few lines, prose or a small list) telling the user: which backend is active, what file(s) it's configured through, and that no extra MCP server is required for this path.
