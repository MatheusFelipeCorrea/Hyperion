# 📁 Where generated files go

Quick view. **Per skill:** [skills-output-map.md](../reference/skills-output-map.md) · **When to use:** [skills-catalog.md](../reference/skills-catalog.md)
**Português:** [onde-ficam-os-outputs.md](./onde-ficam-os-outputs.md)

In a clean clone, folders like `plans/` and `audits/results/` are empty until you run commands that create content.
Config: **`project.yml` → `outputs`**

---

![Output map](../assets/hyperion-outputs-map.png)

---

## By type (summary)

| Artifact | Folder | Sync board? |
|----------|--------|-------------|
| Cards (source) | `.github/cards/` | Yes |
| Specs / plans | `.github/plans/specs/`, `implementations/` | No |
| Reviews / migrations | `.github/plans/reviews/`, `migrations/` | No |
| PR body drafts (`/pr`) | `.github/plans/prs/` | No |
| Audits | `.github/audits/results/` | No |
| ADR / retros | `.github/docs/adr/`, `retros/` | No |
| Diagrams | `.github/diagrams/` | No |

Diagram types (`/diagram`): see [diagrams/README.md](../../diagrams/README.md).

---

## Customize paths

```yaml
outputs:
  audits: .github/audits/results
  cards: .github/plans/cards
  implementations: .github/plans/implementations
  diagrams: .github/diagrams
```

---

## See also

- [skills-output-map.md](../reference/skills-output-map.md) — full skill → path table
- [full-flow-en.md](./full-flow-en.md) — when each artifact enters the SDLC
