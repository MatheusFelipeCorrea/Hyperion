# Hyperion CLI first-run demo

`hyperion-first-run.tape` is a [Charm VHS](https://github.com/charmbracelet/vhs) script for a short terminal walkthrough (`doctor` → `detect-language` → `pipeline-gates` → `process-guard`).

Generate the GIF (Docker required):

```bash
docker run --rm -v "$PWD/docs/demo:/vhs" ghcr.io/charmbracelet/vhs hyperion-first-run.tape
```

On Windows PowerShell, from the repo root:

```powershell
docker run --rm -v "${PWD}/docs/demo:/vhs" ghcr.io/charmbracelet/vhs hyperion-first-run.tape
```

Output: `docs/demo/hyperion-first-run.gif` — safe to commit and link from the README when you are happy with the take.

This is a **CLI usability** recording, not a cinematic product video. AI video generators cannot render real Hyperion UI/terminal chrome reliably; VHS (or a manual screen capture) is the right tool for that gap.
