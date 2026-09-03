# Contribuindo com o Hyperion

Obrigado por considerar contribuir! Este kit é open-source e aceita PRs.

**Repositório:** [https://github.com/MatheusFelipeCorrea/Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion)

Ao participar, você concorda com o [Code of Conduct](CODE_OF_CONDUCT.md).  
Segurança: [SECURITY.md](SECURITY.md) — não abra issue pública para vulnerabilidades.  
Ajuda de adotante: [SUPPORT.md](SUPPORT.md). Histórico de mudanças: [CHANGELOG.md](CHANGELOG.md).

## Por onde começar

1. Leia [GETTING-STARTED.md](GETTING-STARTED.md) (visão de adotante).
2. Procure issues com o label **`good first issue`** ou **`help wanted`**.
3. Comente na issue antes de grandes mudanças (evita trabalho duplicado).
4. Abra sua branch a partir de **`dev`**, não de `main` (veja "Fluxo de branches" abaixo) — a `main` é protegida — sem push direto.

## Fluxo de branches

| Branch | Papel | Quem manda PR pra cá |
|--------|-------|------------------------|
| **`main`** | O que `git clone`/`hyperion:upgrade` puxa. Sempre limpa — zero vínculo com este repositório específico (sem GitHub Project vinculado, sem card real, sem config pessoal propagada). | Só `qa`, manualmente, depois de tudo verde |
| **`dev`** | Integração — todo `feat/*`/`fix/*` abre PR pra cá | Contribuidores e mantenedor |
| **`qa`** | Release candidate — valida antes de promover pra `main` | `dev`, quando um lote está pronto |
| **`internal`** | Uso real do próprio Hyperion nele mesmo (board vinculado, cards reais) | Nunca manda PR de volta — só puxa de `main` |

**A `main` nunca deve ter vínculo com este repositório específico.** Um check dedicado (`npm run hyperion:distribution-purity-check`, rodando em todo PR pra `main`/`dev`/`qa` via `hyperion-validate.yml`) garante isso automaticamente — projectNumber tem que ser nulo, `hyperion-sync-cards.yml` não pode ter gatilho de push, `CODEOWNERS`/`FUNDING.yml` não podem propagar via upgrade, e nenhum card real pode existir fora de `_examples/`. **Se esse check (ou qualquer outro do `hyperion-validate.yml`) falhar, o PR não pode ser mergeado — sem exceção, mesmo que pareça um detalhe pequeno.** Corrija na branch de origem e deixe rodar de novo.

## Como contribuir

1. Fork [MatheusFelipeCorrea/Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion)
2. Crie uma branch a partir de `dev` para sua feature (`git checkout -b feature/minha-skill dev`)
3. Faça suas alterações
4. Valide localmente antes do PR:
   ```bash
   npm run docs:check              # links em markdown
   npm run skills:validate         # frontmatter + ## Output das skills
   npm run hyperion:check-rules    # runtime rules sincronizadas
   npm run hyperion:skills-catalog -- --check  # se tocou catálogo/meta
   npm run hyperion:project-verify # smoke do project.yml do kit
   npm run cards:test              # testes do cards-sync
   npm test                        # hyperion + cards
   node scripts/cards-sync/sync.mjs --dry-run   # se alterou cards/sync
   ```
   Sem Node: `./bin/hyperion` — [node-and-docker.md](.github/docs/meta/node-and-docker.md). Gates: [definition-of-done.md](.github/docs/meta/definition-of-done.md).
5. Commit com mensagem descritiva
6. Abra um Pull Request (use o template do repositório)

## Tipos de contribuição

- **Nova skill** — crie em `.github/skills/<categoria>/sua-skill/SKILL.md`
- **Novo prompt de auditoria** — adicione em `.github/audits/prompts/` e registre no `manifest.yml`
- **Bug fix** — descreva o comportamento esperado vs. atual
- **Documentação** — melhorias no README, exemplos, traduções (ótimo primeiro PR)

## Padrões

- Skills são Markdown puro (sem dependências externas)
- Nomes de skills em inglês (kebab-case)
- Documentação bilíngue quando possível (PT-BR primário, EN secundário)
- Mantenha compatibilidade multi-runtime (Copilot, Cursor, Claude Code)
- Não copie `project.yml` / workflows dogfood do kit em exemplos de adoção — use `project.example.yml` e `/pipeline`

## Estrutura de uma Skill

```
.github/skills/<categoria>/minha-skill/
└── SKILL.md
```

Use [`.github/skills/SKILL.template.md`](.github/skills/SKILL.template.md) como ponto de partida.

O `SKILL.md` deve ter:
- Frontmatter YAML com `name` e `description`
- Passos claros e numerados
- Regras/constraints
- Pelo menos um exemplo de uso
- **Caminho de output explícito** — onde gravar artefatos (ver [onde-ficam-os-outputs.md](.github/docs/meta/onde-ficam-os-outputs.md))

### Onde gravar outputs (novas skills)

| Tipo de artefato | Pasta padrão |
|------------------|--------------|
| Card syncável | `.github/cards/{epics,features,stories,tasks}/` |
| Spec / plano | `.github/plans/specs/` ou `implementations/` |
| Relatório | `.github/audits/results/<tipo>/` |
| Decisão permanente | `.github/docs/adr/` ou `memory/DECISIONS.md` |
| Descoberta de produto | `.github/memory/discoveries/` |

Leia `project.yml` → `outputs` antes de inventar paths. Registre auditorias em `audits/manifest.yml`.

### Novo comando ou slash phrase

1. Adicione entrada em `.github/commands.yml`
2. Rode `npm run hyperion:generate-rules` e commite os arquivos gerados
3. Atualize `comandos-rapidos.md` + `quick-commands-en.md` se o comportamento visível mudar
4. `npm run hyperion:check-rules` deve passar no CI

## Licença

Ao contribuir, você concorda que suas contribuições serão licenciadas sob MIT.

## Manutenção de docs (só mantenedores do kit)

Política interna de cadência e anti-duplicação: [doc-maintenance-policy.md](.github/docs/meta/doc-maintenance-policy.md).

Comandos extras após editar o kit:

```bash
npm run hyperion:generate-rules
npm run hyperion:skills-eval
npm run docs:check
npm test
```
