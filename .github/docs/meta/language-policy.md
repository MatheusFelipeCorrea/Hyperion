# Política de idioma (idioma do repositório e múltiplos idiomas)

**English:** [language-policy-en.md](./language-policy-en.md)

O Hyperion escreve no idioma que o seu time usa. Você escolhe uma vez (o setup pergunta); todo agente, script e mensagem de CI segue essa escolha.

## Configurar

```yaml
# .github/project.yml
locale: pt-BR              # idioma principal — qualquer tag BCP 47 (en, pt-BR, es, fr, de-AT…)
languages: [pt-BR, en]     # opcional; principal primeiro; mais de um = multilíngue
i18n:
  multilingual: [pr, comments, release]   # padrão; também: docs, issues
```

| Forma | Como |
|-------|------|
| Chat | `/setup` ou `/discover` — o agente roda `npm run hyperion:detect-language`, sugere um idioma e pede confirmação |
| Terminal | `npm run hyperion:setup -- --locale pt-BR --languages pt-BR,en` |
| Na mão | Edite o `project.yml`; `npm run hyperion:project-verify` valida |

Sem `locale` → o Hyperion usa `en` e o `hyperion:doctor` avisa.

## O que sai em qual idioma

| O quê | Idioma |
|-------|--------|
| Respostas no chat | O idioma da pessoa |
| Cards, specs, planos, ADRs, memória, auditorias, relatórios | Principal (`locale`) |
| Título/corpo de PR, comentários de PR e review, release notes | Principal; os `languages` extras em blocos `<details>` recolhidos quando a superfície está em `i18n.multilingual` |
| Mensagens de commit | Tipo/escopo Conventional em inglês + assunto no idioma principal |
| Código, identificadores, branches, `CARD_ID`, caminhos, flags de CLI | Sempre inglês |
| Nomes de jobs e steps do GitHub Actions | Sempre inglês (required checks casam pelo nome) |

Cards ficam em um idioma só: senão o board duplicaria todo título. Coloque `issues` em `i18n.multilingual` só se o time quiser mesmo cards bilíngues.

### Exemplo de commit

```text
feat(auth): adiciona login com Google
fix(cards): corrige status duplicado no board
```

Tipo e escopo ficam em inglês porque o changelog, o `release` e o gate de título de PR fazem parse deles.

### Exemplo de PR multilíngue (`languages: [pt-BR, en]`)

```markdown
## Resumo
Adiciona login com Google.

<details><summary>English</summary>

## Summary
Adds Google sign-in.

</details>
```

## Mensagens fixas dos scripts

Comentários de CI, resumos de cobertura, o board guard e o relatório de reconcile vêm de catálogos de mensagens, não do agente:

| Catálogo | Caminho |
|----------|---------|
| Do kit | `scripts/hyperion/i18n/en.json`, `pt-BR.json`, `es.json` |
| Override seu / idioma novo | `.github/i18n/<tag>.json` (mesmas chaves do `en.json`) |

Ordem de busca: tag exata → idioma base → tag do kit com a mesma base → `en` (então `pt-PT` usa `pt-BR`, e `fr` sem catálogo sai em inglês). O `hyperion:doctor` lista as chaves faltando.

Depois de mudar `locale` ou `languages`, regenere o CI do produto (`npm run hyperion:pipeline-apply -- --yes`) para os comentários saírem no idioma novo.

## Relacionado

- Regras de runtime: seção Language em `CLAUDE.md`, `.cursor/rules/hyperion.mdc`, `.github/copilot-instructions.md` (geradas por `scripts/hyperion/commands-lib.mjs`)
- Detecção: `npm run hyperion:detect-language` (README, commits recentes, títulos de PR)
