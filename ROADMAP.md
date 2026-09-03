# Roadmap

Onde o Hyperion está indo — não uma promessa de data, uma pista de prioridade. O `[Unreleased]` do [CHANGELOG.md](./CHANGELOG.md) mostra o que já foi corrigido; este arquivo mostra o que vem depois.

Atualizado a cada rodada de auditoria que muda a direção — não a cada PR.

## Agora

O que está ativamente em progresso ou é a próxima aposta clara:

- **Fechar o padrão dry-run-by-default no resto do cards-sync.** `watch.mjs` e o `workflow_dispatch` manual de `hyperion-sync-cards.yml` já pedem confirmação antes de escrever no board real. `migrate-layout.mjs` ainda roda live sem `--yes` — mesmo padrão, falta alinhar.
- **Cobertura de teste pra hierarquia pai-filho nos 4 backends.** Azure/GitLab/Linear acabaram de ganhar paridade com o Jira (`buildEdges` + linking próprio de cada API) — nenhum dos 4 tem teste isolado pra essa lógica ainda, só o fluxo completo.
- **E2E cobrindo reverse-sync**, não só forward — é o caminho que os 4 backends não-GitHub citam como obrigatório, e o mais arriscado (escreve no próprio repo).

## Próximo

Ideias com escopo claro, esperando uma janela de trabalho:

- **`hyperion:project-fields-apply`** — criar/renomear os 8 campos exigidos no GitHub Project via `gh api`, tirando o maior passo manual do primeiro `/setup`.
- **Pre-flight de conectividade pra Azure/GitLab/Linear no `doctor.mjs`** — hoje só GitHub/Jira têm checagem antes do sync de verdade.
- **`hyperion:audit-diff`** — comparar uma rodada de `/audit-run` com a anterior, dimensão por dimensão. `.github/audits/results/` já acumula os relatórios; falta o diff.
- **Servidor MCP próprio do Hyperion** — expor `doctor`/`sync`/`cards` como MCP tools, reduzindo a dependência de pacotes MCP de terceiros (3 dos 4 hoje documentados são comunitários de mantenedor único).

## Mais pra frente

Reais, mas sem prazo — dependem de mais tração ou de uma decisão que ainda não foi tomada:

- Cobertura de ciclo de vida em skills novos (feature flags, métricas de engenharia, compliance, contrato de API).
- GitHub App como alternativa ao PAT pro cards-sync (rotação de credencial mais durável pra times).
- Telemetria opt-in, 100% local, de uso de skills/agentes — sem isso, decisão de onde investir no catálogo continua sendo intuição.

## O que não está no roadmap (de propósito)

- **"Hyperion Cloud" / monetização.** Contradiz o pitch central — o kit roda 100% local, sem serviço hospedado por trás.
- **Vídeo/demo em GIF.** Excluído por decisão explícita — não é prioridade agora.

## Como isso é decidido

Cada auditoria periódica do kit (arquiteta o [Painel Hyperion](https://claude.ai/code/artifact/65052811-fb21-49b5-b17e-ba184fcb45ee) e o [Backlog de fechamento](https://claude.ai/code/artifact/4790a8a3-b263-4322-bff6-8ae6cb619976)) reavalia gaps e ideias de expansão, prioriza por impacto/esforço, e este arquivo é atualizado com o resultado. Não é uma lista fixa — itens sobem, descem ou saem conforme o kit muda.

Quer sugerir algo? Abra uma [issue](https://github.com/MatheusFelipeCorrea/Hyperion/issues/new/choose) ou comece por uma das [good first issue](https://github.com/MatheusFelipeCorrea/Hyperion/labels/good%20first%20issue).
