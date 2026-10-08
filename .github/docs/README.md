# 📚 Hyperion — índice de documentação

<p align="center">
  <img src="./assets/hyperion-logo.png" alt="Hyperion" width="140">
</p>

<p align="center">
  <a href="../../README.md"><img src="https://img.shields.io/badge/hub-README-F5D76E?style=for-the-badge&labelColor=0B1220" alt="README"></a>
  <a href="../../GETTING-STARTED.md"><img src="https://img.shields.io/badge/▶_começar-GETTING--STARTED-2563EB?style=for-the-badge&labelColor=0B1220" alt="Start"></a>
  <a href="./reference/catalogo-skills.md"><img src="https://img.shields.io/badge/🧩_skills-catálogo-2563EB?style=for-the-badge&labelColor=0B1220" alt="Skills"></a>
  <a href="./reference/comandos-rapidos.md"><img src="https://img.shields.io/badge/💬_comandos-lista-2563EB?style=for-the-badge&labelColor=0B1220" alt="Commands"></a>
</p>

**Não leia tudo no dia 1.** Use este índice como guia de estudo.

| Badge | Para quem |
|-------|-----------|
| <img src="https://img.shields.io/badge/🟢-iniciante-22C55E?style=flat-square&labelColor=0B1220" alt="iniciante"> | Chat + 6 comandos |
| <img src="https://img.shields.io/badge/🟡-intermediário-EAB308?style=flat-square&labelColor=0B1220" alt="intermediário"> | GitHub, cards, repo |
| <img src="https://img.shields.io/badge/🔵-avançado-2563EB?style=flat-square&labelColor=0B1220" alt="avançado"> | SDLC, CI, backends no **seu** produto |

---

## 1. Entender o produto

| Doc | O que responde |
|-----|----------------|
| [README.md](../../README.md) | O que é, áreas, skills, comandos · [EN](../../README.en.md) |
| [GETTING-STARTED.md](../../GETTING-STARTED.md) | Glossário + primeiros passos · [EN](../../GETTING-STARTED.en.md) |
| [trilha-de-aprendizado.md](./onboarding/trilha-de-aprendizado.md) | Ordem de estudo 🟢→🔵 · [EN](./onboarding/learning-path-en.md) |

## 2. Usar no dia a dia

| Doc | O que responde |
|-----|----------------|
| [comandos-rapidos.md](./reference/comandos-rapidos.md) | O que digitar no chat / npm |
| [catalogo-skills.md](./reference/catalogo-skills.md) | Cada skill: quando · comando · output |
| [armadilhas-comuns.md](./troubleshooting/armadilhas-comuns.md) | Erros frequentes |

## 3. Encaixar no seu repo

| Doc | O que responde |
|-----|----------------|
| [setup-github.md](./onboarding/setup-github.md) | Projects + `gh` |
| [adaptar-ao-repo.md](./onboarding/adaptar-ao-repo.md) | Repo legado → `/migrate` |
| [escolher-backend.md](./integration/escolher-backend.md) | Jira / Azure / Linear / GitLab |
| [node-and-docker.md](./meta/node-and-docker.md) | Sem Node no laptop |

## 4. Aprofundar

| Doc | O que responde |
|-----|----------------|
| [fluxo-completo.md](./meta/fluxo-completo.md) | SDLC ponta a ponta |
| [definition-of-done.md](./meta/definition-of-done.md) | Gates `*-verify` |
| [onde-ficam-os-outputs.md](./meta/onde-ficam-os-outputs.md) | Onde a IA grava arquivos |
| [skills-output-map.md](./reference/skills-output-map.md) | Mapa skill → pasta |
| [language-policy.md](./meta/language-policy.md) | Idioma do repo, multilíngue, o que fica em inglês · [EN](./meta/language-policy-en.md) |

Docs com versão em outro idioma ficam listados em [translations.json](./translations.json) — o `npm run docs:check` falha se um par sumir ou deixar de linkar o outro.

---

## Por pasta

| Pasta | Conteúdo |
|-------|----------|
| `onboarding/` | setup, trilha, adaptar-ao-repo |
| `reference/` | comandos, catálogo, cheatsheets |
| `integration/` | GitHub CLI, backends, pipeline |
| `quality/` | primeira auditoria |
| `troubleshooting/` | armadilhas |
| `meta/` | organização, fluxo, DoD, Node/Docker |

![Mapa da documentação](./assets/hyperion-docs-map.png)

*Fonte:* [`hyperion-docs-map.mmd`](./assets/hyperion-docs-map.mmd)

Mapa de pastas do kit: [STRUCTURE.md](../STRUCTURE.md) · Contribuir: [CONTRIBUTING.md](../../CONTRIBUTING.md)
