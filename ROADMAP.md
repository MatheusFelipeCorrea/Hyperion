# Roadmap

Onde o Hyperion está indo — não uma promessa de data, uma pista de prioridade. O `[Unreleased]` do [CHANGELOG.md](./CHANGELOG.md) mostra o que já foi corrigido; este arquivo mostra o que vem depois.

Atualizado a cada rodada de auditoria que muda a direção — não a cada PR.

## Fechado nesta rodada (set/2026)

Todo item que este arquivo listava em Agora/Próximo/Mais pra frente foi implementado — 30 commits em `feat/agora-lane-items`, PR #80. Destaques: dry-run-by-default em todo cards-sync (`migrate-layout.mjs` alinhado), teste isolado de hierarquia pai-filho nos 4 backends, E2E cobrindo reverse-sync, `hyperion:project-fields-apply`, `hyperion:audit-diff`, servidor MCP próprio (doctor + project-verify, sem dependência de SDK), `hyperion:create` (scaffold local), `cards:history`, notificador Slack/Discord, `labels-reset.mjs` estendido (GitLab + correção real do Linear), license-checker, guia de "como adicionar um backend novo", suporte a Windsurf/Zed, teste de paridade `commands.yml`↔filesystem, 4 skills novos de cobertura de SDLC, telemetria opt-in, concorrência limitada no sync, e 2 ADRs (split de `sync.mjs`/`lib.mjs` e GitHub App vs PAT — avaliados e adiados por decisão registrada, não esquecidos).

Ver `[Unreleased]` do [CHANGELOG.md](./CHANGELOG.md) pra lista completa com hashes de commit.

## Agora / Próximo / Mais pra frente

Vazio de propósito — esta rodada zerou o backlog anterior. As próximas prioridades saem da próxima auditoria (`/audit-run`), não de reciclar o que já foi feito. `npm run hyperion:audit-diff` vai comparar essa futura rodada com a anterior quando ela existir.

## O que não está no roadmap (de propósito)

- **"Hyperion Cloud" / monetização.** Contradiz o pitch central — o kit roda 100% local, sem serviço hospedado por trás.
- **Vídeo/demo em GIF.** Excluído por decisão explícita — não é prioridade agora.

## Como isso é decidido

Cada auditoria periódica do kit (arquiteta o [Painel Hyperion](https://claude.ai/code/artifact/65052811-fb21-49b5-b17e-ba184fcb45ee) e o [Backlog de fechamento](https://claude.ai/code/artifact/4790a8a3-b263-4322-bff6-8ae6cb619976)) reavalia gaps e ideias de expansão, prioriza por impacto/esforço, e este arquivo é atualizado com o resultado. Não é uma lista fixa — itens sobem, descem ou saem conforme o kit muda.

Quer sugerir algo? Abra uma [issue](https://github.com/MatheusFelipeCorrea/Hyperion/issues/new/choose) ou comece por uma das [good first issue](https://github.com/MatheusFelipeCorrea/Hyperion/labels/good%20first%20issue).
