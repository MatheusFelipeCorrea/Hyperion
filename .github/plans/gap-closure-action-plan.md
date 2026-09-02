# Plano de ação — itens pendentes e parciais

**Data:** 2 set 2026 · **Branch base:** `main` · **Escopo:** gaps que exigem decisão humana, credenciais ou repo externo (vídeo excluído).

---

## Legenda

| Status | Significado |
|--------|-------------|
| ✅ Feito nesta rodada | Implementado em código nesta sessão |
| 🔶 Parcial | Infra pronta; falta execução/config externa |
| ⏳ Pendente | Ação manual ou em outro repositório |

---

## ✅ Fechado em código (esta sessão)

| Gap | Solução |
|-----|---------|
| Observabilidade (4.6) | `sync-history.jsonl` append-only em `.github/plans/cards/` — forward-sync + pr-guard |
| MCP (5.5) | `.github/mcp/servers.example.json` + README + link no integration-bridge |
| FUNDING.yml | Template em `.github/FUNDING.yml` (descomentar username) |
| POC/Proto/Spike (7.2) | Árvore de decisão no card-refiner SKILL + eval case |
| Trilha PM (8.5) | `trilha-pm.md` + linha nas trilhas PT/EN |
| LLM eval (7.0) | `hyperion:llm-eval` — fixture mode em CI; live opt-in via env |
| Doc drift prosa (8.5) | `docs:prose-check` — 5 regras de paths obsoletos |
| Runtime SSOT hook | pre-commit regen rules quando `commands.yml` muda |
| Upgrade CHANGELOG | `recordUpgradeChangelog()` após `--yes` |
| Coverage | `npm run test:coverage` (Node experimental) |
| install-hook test | `install-hook.test.mjs` — nested + legacy layouts |

---

## ⏳ P0 — Release v0.2.0

**Estado:** CHANGELOG `[Unreleased]` pronto · tag ainda `v0.1.0`

| # | Ação | Responsável | Comando / nota |
|---|------|-------------|----------------|
| 1 | Revisar CHANGELOG `[Unreleased]` | Maintainer | Ler diff desde v0.1.0 |
| 2 | Bump `package.json` → `0.2.0` | Maintainer | `/release` ou manual |
| 3 | Commit + tag `v0.2.0` | Maintainer | `git tag -a v0.2.0` |
| 4 | `gh release create v0.2.0` | Maintainer | Anexa SBOM (workflow docker-publish) |
| 5 | Verificar `hyperion-docker-publish.yml` na tag | CI | Primeira execução real ghcr.io |

**Critério de done:** Release publicada no GitHub · pin em `.github/hyperion-kit.json` dos dogfoods atualizado.

---

## 🔶 P0 — E2E cards com repo descartável

**Estado:** Workflow `hyperion-e2e-cards.yml` + guard `.git` fix · nunca rodou com token real

| # | Ação | Responsável |
|---|------|-------------|
| 1 | Criar repo vazio `hyperion-e2e-sandbox` (ou org interna) | Maintainer |
| 2 | Adicionar secret `PROJECT_SYNC_TOKEN` (classic PAT ou fine-grained: issues+projects) | GitHub Settings |
| 3 | Configurar var `E2E_TARGET_REPO=owner/hyperion-e2e-sandbox` no repo Hyperion | Actions vars |
| 4 | `workflow_dispatch` manual → confirmar forward-sync + cleanup | Maintainer |
| 5 | Documentar no README do e2e o par de vars/secrets | Dev |

**Critério de done:** Uma run verde no Actions com mutação real no sandbox (não neste repo).

---

## 🔶 P0 — Ruleset branch protection (board guard)

**Estado:** Código + docs em `cards-sync-hardening.md` · ruleset ainda manual na UI

| # | Ação | Onde |
|---|------|------|
| 1 | Criar ruleset: `main` require PR + status checks | Repo **consumidor** (ex.: Pulso) |
| 2 | Required checks: `hyperion-cards-pr-check`, product CI | GitHub → Rules → Branch rulesets |
| 3 | Habilitar Merge Queue (`merge_group`) se disponível | Org GitHub Team+ |
| 4 | Validar: mover card no board sem commit → PR check falha | Teste manual |
| 5 | Validar: commit no PR com status novo → passa (forward-pending) | Teste manual |

**Nota:** Não automatizável 100% via `gh api` hoje — depende do plano GitHub da org.

---

## ⏳ P1 — Dogfood em Pulso

**Estado:** Kit pronto · consumidor externo

| # | Ação |
|---|------|
| 1 | Copiar/atualizar kit no repo Pulso (`hyperion:upgrade --yes`) |
| 2 | `project.yml` com `management.backend: github` + `projects-map.json` |
| 3 | Instalar secrets `PROJECT_SYNC_TOKEN` no Pulso |
| 4 | Habilitar workflows `hyperion-*` via `hyperion:pipeline-apply --yes` |
| 5 | Primeiro `cards:sync` real + ruleset (item acima) |
| 6 | `npm run cards:hook -- --yes` no Pulso |

---

## 🔶 P1 — Config GitHub (comunidade)

**Estado:** FUNDING.yml template ✅ · Discussions/topics ainda off

| # | Ação | Comando sugerido |
|---|------|------------------|
| 1 | Habilitar Discussions | `gh repo edit --enable-discussions` |
| 2 | Topics | `gh repo edit --add-topic ai-agents --add-topic cursor --add-topic github-projects` |
| 3 | FUNDING | Descomentar `github:` em `.github/FUNDING.yml` + push |
| 4 | (Opcional) Social preview / about | UI GitHub |

**Aguardando:** confirmação do maintainer antes de `gh repo edit` no repo público.

---

## 🔶 P2 — Windows CI `continue-on-error`

**Estado:** `windows-latest` na matriz · primeira rodada real pendente

| # | Ação |
|---|------|
| 1 | Mergear PR com gaps desta sessão → observar 3–5 runs |
| 2 | Se verde estável, remover `continue-on-error` em `hyperion-validate.yml` |
| 3 | Atualizar template em `scripts/hyperion/templates/workflows/` |

---

## Gaps aceitos (não-bug / fora de escopo)

| Item | Motivo |
|------|--------|
| Vídeo demo | Excluído por pedido |
| Community stars/forks | Crescimento orgânico |
| Bitbucket/Circle/Jenkins templates | Feature futura |
| Claude/Cursor kit nested | Limitação das ferramentas |
| Admin bypass merge | Política GitHub |
| Mentoring agent eval | Decisão DoD — conversacional |

---

## Ordem sugerida de execução

```
1. Merge gaps-closure branch → main
2. Release v0.2.0 (tag dispara docker + SBOM)
3. Repo E2E sandbox + workflow_dispatch
4. Dogfood Pulso + ruleset no consumidor
5. gh repo edit (Discussions/topics) — com OK do maintainer
6. Remover continue-on-error Windows após N runs verdes
```

---

## Métricas alvo pós-plano

| Eixo | Antes | Meta |
|------|-------|------|
| Observabilidade | 4.6 | ≥8.0 |
| MCP | 5.5 | ≥8.0 |
| LLM prec. | 7.0 | ≥8.0 (fixture); 9.0 com live periodic |
| Labels tax | 7.2 | ≥8.5 |
| Trilha | 8.5 | ≥9.0 |
| Community | 7.6 | ≥8.5 (pós Discussions/topics) |
| Releases | 8.3 | ≥9.0 (pós v0.2.0 tag) |

**Overall estimado pós-plano completo:** ~8.9–9.0 (excl. vídeo).
