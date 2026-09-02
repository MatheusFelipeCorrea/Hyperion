# Definition of Done — comandos críticos

Como o Hyperion **confirma** que um fluxo terminou de verdade: o LLM age; o **script verifica**.

**English summary:** High-risk skills must leave an artifact and pass a verify script before the agent may say “done”.

**Repo:** [MatheusFelipeCorrea/Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion)

---

## Princípio

| Tipo | Exemplos | Precisão |
|------|----------|----------|
| **Alto risco** | `/discover` Configure, `/migrate`, `/execute`, `/pr-review`, `/implement`, `/spec-review`, `/release`, `/audit-run` | Artefato + `hyperion:*-verify` |
| **Script puro** | `/doctor`, `/sync`, `upgrade`, `repo-detect` | Só o script (sem LLM inventando) |
| **Baixo risco** | `/help`, mentoring (`/mentor`), diagramas | Gate humano basta — sem artefato fixo para verificar |

Não rediscubra o repo em toda skill: leia `.github/project.yml` primeiro; só rode discovery se estiver ausente ou paths stale.

---

## Tabela DoD

| Comando | Artefato | Verify | Não declare done se… |
|---------|----------|--------|----------------------|
| **`/execute`** | Bloco `## Verification` no plan | `npm run hyperion:phase-verify -- --plan <path>` | `tests_result` ≠ `PASS` |
| **`/migrate`** / **`/discover` Configure** | `.github/project.yml` válido | `npm run hyperion:project-verify` | Script exit ≠ 0 |
| **`/pr-review`** | `.github/plans/reviews/pr-*-review.md` | `npm run hyperion:review-verify -- --review <path>` | Falta verdict / summary / tests_ran |
| **`/implement`** | `.github/plans/implementations/*.md` (plano) | `npm run hyperion:plan-verify -- --plan <path>` | Falta frontmatter, fase (`### Phase N`) ou seção Verification |
| **`/spec-review`** | `.github/plans/reviews/{card-id}-review.md` | `npm run hyperion:spec-review-verify -- --review <path>` | Falta card_id / verdict / seções, ou BLOCKED sem issue listada |
| **`/release`** | `CHANGELOG.md` (seção da versão) | `npm run hyperion:release-verify -- --root .` | Falta seção da versão atual ou está vazia |
| **`/audit-run`** | `results/_summary/audit-run-{date}.md` | `npm run hyperion:audit-verify -- --summary <path>` | Falta Executive Summary / Reports / Cross-cutting Themes / Recommended Priority Fixes |

---

## Obrigação do agent

No fim do fluxo de alto risco:

1. Gravar o artefato no formato documentado  
2. Rodar o verify correspondente no terminal  
3. Se exit ≠ 0 → corrigir ou parar — **não** dizer que concluiu  

Humanos podem re-rodar os mesmos comandos a qualquer momento (CI ou chat).

---

## Ver também

- [fluxo-completo.md](./fluxo-completo.md) — SDLC  
- [node-and-docker.md](./node-and-docker.md) — Node nativo ou Docker  
- `npm run hyperion:help`
