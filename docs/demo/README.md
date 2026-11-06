# Hyperion CLI first-run demo

`hyperion-first-run.tape` is a [Charm VHS](https://github.com/charmbracelet/vhs) script for a short terminal walkthrough (`detect-language` → `process-guard` → `pipeline-gates`).

Generate / refresh the GIF (Docker required), from the **repo root**:

```bash
docker run --rm -v "$PWD:/work" -w /work ghcr.io/charmbracelet/vhs docs/demo/hyperion-first-run.tape
```

PowerShell:

```powershell
docker run --rm -v "${PWD}:/work" -w /work ghcr.io/charmbracelet/vhs docs/demo/hyperion-first-run.tape
```

Output: [`hyperion-first-run.gif`](./hyperion-first-run.gif).

This is a **CLI usability** recording, not a cinematic product video.
