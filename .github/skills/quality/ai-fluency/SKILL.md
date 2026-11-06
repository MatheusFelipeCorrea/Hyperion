---
name: ai-fluency
description: >-
  Audits how fluently a workspace uses coding agents and how mature its
  harness is. Produces two comparable scores out of 15 (fundamentals and
  harness) from the AI-Native Kit fluency protocol v2.1, with recommendations
  pointed at Hyperion. Use for /fluency, "fluência de IA", "AI fluency",
  or "harness scan".
---

# AI fluency scan

Measures AI fluency of a workspace. The rubric below is the AI-Native Kit `/ai-fluency-scan` protocol **v2.1**. Section 1 levels, score math, locks, and scorecard labels stay verbatim so a report can be compared with scans that used that protocol. Do not soften a score. When two levels are plausible, pick the lower one and cite the evidence that was missing.

This is measurement. Do not edit source, skills, workflows, or memory during the scan. The only file you write is the report, and only after the question gate.

## When

The person says `/fluency`, "fluência de IA", "AI fluency", "harness scan", or asks how mature the team's AI setup is. This is not `/audit`: `/audit` reviews the product (architecture, security, DevOps, PO, UX). This reviews how the team drives agents.

## Hyperion adaptations

These override the instrument wherever the two disagree.

1. **Output path.** Write the report to `project.yml` → `outputs.audits`, file `_summary/ai-fluency-report.md`. Default: `.github/audits/results/_summary/ai-fluency-report.md`. On a rescan, look there first, then `ai-fluency-report.md` at the workspace root (older scans). Do not add the report to `.gitignore`.
2. **Language.** Narrative follows `locale` from `.github/project.yml` (use `en` when `locale` is unset). Scorecard headings, dimension names, the line `**Protocolo de scan**: v2.1` (colon outside the bold), `**Nível de Fundamentos:**`, and `**Nível de Harness:**` stay exactly as the instrument specifies.
3. **Who "DL" is.** In the instrument, DL is the person who asked for the scan.
4. **Harness kit.** Hyperion (`.github/project.yml` plus `.github/skills/` or `scripts/hyperion/`) is the expected harness. Record it, with a version from `package.json` or `CHANGELOG.md` when you can read one. Do not recommend installing the AI-Native Kit. Two harnesses in one workspace is a gap.
5. **Versioning and leaked workflows.** Hyperion framework files are committed on purpose. Product workflows come from `/pipeline`. A product that contains the kit repo's own CI (`distribution-purity-check`, Docker publish, opt-in e2e, dispatch-only card sync) has a leaked workflow — point at `npm run hyperion:doctor` and the cleanup it prints.
6. **Recommendations** name Hyperion commands (`/explore`, `/spec`, `/implement`, `/pipeline`, `/doctor`, `/review`, `/retro`, `/audit`, `/spec-review`). Same logic as the instrument: foundation first when validation is 0 or 1; adopt or finish Hyperion when the foundation is solid and the harness is thin; do not push a second kit when the harness is already structured.
7. **Question gate.** Score both sections, ask the questions in chat, and stop the turn. Write the file on the next turn, after the answers. Headless runs with no chat write the file immediately and leave the questions open.

## Output

| Artifact | Path |
|----------|------|
| Fluency report | `.github/audits/results/_summary/ai-fluency-report.md` (or `outputs.audits`) |

## Instrument (protocol v2.1)

## /ai-fluency-scan

Audita a fluência de uso de IA e a maturidade de **harness** de um workspace (idealmente multi-projeto: front + back) e gera um `ai-fluency-report.md` com duas seções calibradas — Fundamentos (/15) e Harness (/15) — comparáveis ao longo do tempo.

> **Instrumento de medição — revisão v2.1.** O corpo abaixo é o prompt de auditoria embutido verbatim. Fonte versionada: `intent/specs/CRAFTY-013-comando-scan-fluencia/prompt-v2-source.md`.
>
> **Não altere os critérios, níveis ou o cálculo de score da Seção 1.** Eles sustentam a **série histórica** dos times — mexer neles quebra a comparabilidade entre ciclos e invalida as medições anteriores. A mesma trava vale para o contrato de formato do relatório (rótulos e colunas dos scorecards): é o que permite reler os scans passados.
>
> Modelo recomendado: Opus + extended thinking (auditoria é raciocínio estratégico).

---

Você é um auditor de fluência de uso de IA em projetos de software. Sua tarefa é analisar o **workspace** informado — que idealmente contém mais de um projeto (ex: front + back, ou vários serviços) — e gerar um relatório em **duas seções**:

- **Seção 1 — Fundamentos:** o diagnóstico clássico em 5 dimensões (contexto persistente, planejamento, skills, MCP, validação). Mede o que está *instalado e configurado*. **Preserva a série histórica** — nada aqui muda em relação à versão anterior.
- **Seção 2 — Harness:** um diagnóstico complementar que mede como esses artefatos se articulam num **circuito de controle vivo** (guides, sensors, steering loop, distribuição, auto-correção). Mede o *harness* no sentido de Fowler ("Harness engineering for coding agent users").

> As duas seções compartilham a mesma gramática: dimensões com níveis nomeados (Inexistente/Inicial/Estruturado/Avançado → 0-3), análise em "o que foi encontrado / positivo / gaps", e recomendações acionáveis. A Seção 2 **reaproveita** o que a Seção 1 já detectou em vez de remedir do zero, e **acrescenta** diagnósticos próprios (hooks, testes estruturais, caps de tentativa, mensagens otimizadas para LLM) que a Seção 1 não olha.

## Calibração (leia antes de pontuar)

Este é um instrumento de medição, não um elogio. O erro mais comum é ser generoso. Portanto:

- **Na dúvida entre dois níveis, escolha o menor** e justifique com a evidência concreta que faltou para subir. Não arredonde para cima "no benefício da dúvida".
- **Existência nunca basta.** Um arquivo presente mas genérico, auto-gerado sem refino, ou desatualizado é nível **Inicial**, não Estruturado. Só sobe quem tem conteúdo específico do projeto e em uso.
- **Cite a evidência por trás de cada nota.** Se você não consegue apontar o arquivo/linha/log que sustenta o nível, o nível está alto demais.
- **Um score honesto e baixo é mais útil que um inflado.** O relatório vira decisão de gestão e comparação ao longo do tempo — inflar quebra a série e engana o time.

## Fase 0 — Reconhecimento do workspace (faça isto ANTES de qualquer dimensão)

O alvo do scan é um **workspace**, não necessariamente um repositório único. Um time normalmente tem front e back, que podem estar em repos separados, em pastas irmãs, ou num monorepo. Antes de pontuar qualquer coisa, mapeie a topologia:

1. Liste a estrutura do workspace (2-3 níveis de profundidade a partir da raiz informada).
2. **Identifique os projetos** procurando por manifestos de projeto em qualquer nível: `package.json`, `*.csproj`/`*.sln`, `pom.xml`/`build.gradle`, `go.mod`, `requirements.txt`/`pyproject.toml`, `Cargo.toml`, `Gemfile`, `composer.json`, `mix.exs`, `pubspec.yaml`. Cada manifesto marca a raiz de um projeto.
3. **Classifique a topologia** e registre no cabeçalho do relatório:
   - **Repo único** — um só projeto. Rode o scan normalmente (comportamento da v1).
   - **Multi-projeto em pastas** — front e back (e afins) como subpastas do mesmo workspace.
   - **Monorepo** — múltiplos projetos sob um gerenciador (`turbo.json`, `nx.json`, `pnpm-workspace.yaml`, `lerna.json`, workspaces do npm/yarn).
4. **Rotule cada projeto** por papel provável (frontend, backend, mobile, infra, biblioteca) e stack, a partir do manifesto e da estrutura.

### Como pontuar workspace multi-projeto

Um artefato de harness/fluência pode ser **compartilhado** (na raiz do workspace, valendo para todos) ou **local** (dentro de um projeto). Isso importa porque a distribuição revela a maturidade real:

- **Avalie cada dimensão por projeto** e também no nível do workspace (artefatos de raiz).
- **Config na raiz agregadora vale para todo o workspace — procure-a lá.** Num monorepo ou num multi-repo com um workspace agregador, os artefatos que governam todos os projetos vivem tipicamente na **raiz**: `.claude/commands/` (comandos slash), `.claude/hooks/` (hooks), `.claude/skills/` (skills), `CLAUDE.md`/rules (contexto) e a config de MCP. **Procure-os na raiz, além de dentro de cada projeto**, e credite-os a todos os projetos que eles de fato governam — não marque um projeto como carente de um guide/sensor que a raiz provê para o workspace inteiro.
- **A regra de consolidação por dimensão é o pior elo qualificado, não a média:** um workspace onde o back tem CI/testes maduros mas o front não tem nenhum sensor **não** é "Estruturado na média" — a fluência real é limitada pelo projeto mais fraco que faz parte do fluxo de entrega. Reporte o score consolidado puxando para baixo quando um projeto relevante está descoberto, e **explicite a assimetria** (ex: "Sensors: back Estruturado (2), front Inexistente (0) → consolidado Inicial (1), assimetria front/back"). **O "pior elo" mede o que falta *depois* de contar a config compartilhada:** um projeto só é elo fraco numa dimensão se nem ele nem a raiz a cobrem. Config de raiz que comprovadamente governa todos **levanta todos** — não é "o projeto não tem", é "o workspace tem de forma compartilhada".
- **Contexto compartilhado conta a favor:** um CLAUDE.md/rules na raiz cobrindo os dois lados, ou um monorepo com config unificada, é sinal de maturidade — pontue melhor do que configs duplicadas e divergentes por projeto.
- **Existência na raiz não basta — confirme que o artefato atua no fluxo do projeto.** Um artefato compartilhado só credita um projeto se de fato roda/vale para ele. Cuidado especial com hooks: um hook na raiz pode disparar apenas a partir do diretório primário e **não** cobrir um sub-repo aberto isoladamente. Se a config de raiz não governa comprovadamente um projeto, registre a limitação e não credite cego (coerente com a calibração "existência nunca basta").
- **A assimetria front/back é ela própria um achado de harness.** O back costuma ter sensors mais maduros (CI, teste, tipagem) e o front costuma ter mais guides de IA (rules, componentes) — registre onde cada lado está e trate o desequilíbrio como gap a nomear, não como detalhe a esconder na média.

> Se o workspace tiver **um só projeto**, ignore a lógica de consolidação e rode como na v1 — o prompt tem que funcionar nos dois casos. Se a raiz informada não contém manifesto algum nem subprojetos reconhecíveis, trate como repo único e siga.

### Detecção do AI-Native Kit e sua versão

O framework de harness da dti já se chamou, em ordem, **craft-ai** → **sdd-kit** → **AI-Native Kit**. É o mesmo kit; só mudou de nome entre gerações. Um repo pode ter artefatos de qualquer uma delas. Detecte a presença e, se presente, **registre a versão/geração** — é insumo do relatório e de uma pergunta ao DL.

1. **Detecte a presença do kit** por qualquer destes sinais: Hyperion (`.github/project.yml` junto de `.github/skills/` ou `scripts/hyperion/`); diretório `.ai-native-kit/` ou `.sdd/`; comandos slash típicos (`/feature`, `/implement`, `/review`, `/retro`, `/discover`); ou menções textuais a "craft-ai", "Craft.ai", "sdd-kit", "AI-Native Kit" ou "Hyperion" em `CLAUDE.md`, configs ou constituição. Hyperion encontrado é o harness a registrar — ver "Hyperion adaptations".
2. **Descubra a versão**, tentando nesta ordem (pare no primeiro que resolver):
   - Campo `version` num manifesto do kit (`plugin.json`, `package.json` do kit, `config.json` do kit, ou similar).
   - Nome+versão do pacote no lockfile / dependências (ex: `ai-native-kit-plugin@x.y.z`, `ai-native-kit@x.y.z`, `sdd-kit@...`, `craft-ai@...` em `package-lock.json`, `pnpm-lock.yaml`, ou feed do Azure Artifacts).
   - Se não houver número em lugar algum, **infira a geração pelo nome**: se os arquivos ainda dizem "craft-ai" ou "sdd-kit", é geração **anterior** à atual (AI-Native Kit), independentemente de número.
3. **Registre no cabeçalho do relatório** um campo "Kit de harness detectado" com nome/geração e versão (ou "versão não identificada — geração [X] pelo nome").
4. **A versão do kit vira RECOMENDAÇÃO adicional, nunca pergunta.** No Hyperion o harness esperado é o próprio Hyperion (`.github/skills/`, `scripts/hyperion/`, `CLAUDE.md`, `.cursor/rules/` versionados). Registre o nome e, se achar, a versão em `package.json` ou no `CHANGELOG.md`.
   - Hyperion presente: não recomende instalar outro kit. Se o pin local (`.github/hyperion-kit.json`) estiver atrás do que o próprio `CHANGELOG` descreve como atual, recomende `npm run hyperion:upgrade` (dry-run primeiro).
   - Nomenclatura antiga (`craft-ai` / `sdd-kit` / AI-Native Kit) **ao lado** do Hyperion: gap de dois harnesses. Recomende ficar com o Hyperion. Não aponte a página do AI-Native Kit como destino.
   - Só o kit antigo, sem Hyperion: recomende adotar o Hyperion (`/setup` em repo novo, `/migrate` em repo que já tem código).
   - Não transforme versão em pergunta. Um kit defasado explica steering (H3) fraco: correção feita na fonte que não chegou ao repo. A ação é atualizar o Hyperion, não gitignorar os scripts dele.

## Instruções de execução

1. Faça a **Fase 0** acima e fixe a topologia antes de tudo.
2. Para cada projeto identificado, e para a raiz do workspace, procure os arquivos e diretórios de cada dimensão.
3. Quando encontrar um arquivo relevante, **leia seu conteúdo para avaliar a qualidade** (não apenas a existência). A existência de um arquivo nunca é suficiente para pontuar — a qualidade do conteúdo é o que define o nível.
4. **Seção 1:** NÃO execute comandos git, NÃO acesse APIs externas, NÃO use MCPs. O scan da Seção 1 é 100% baseado em leitura de arquivos — isso garante reprodutibilidade e comparabilidade entre times ao longo do tempo. **Única exceção:** ler a data do primeiro commit (`git log --reverse`) para estimar a idade do sistema é permitido, pois o git já será usado na Seção 2 e essa data é uma fonte de idade melhor que perguntar ao DL. Nada mais de git entra no score da Seção 1.
5. **Seção 2:** você **pode** usar `git log`, `git blame` e inspeção de histórico, mas apenas conforme as regras da subseção "Uso de git na Seção 2" abaixo. Git é evidência qualitativa (sobretudo de steering loop), **nunca um contador que soma pontos**. Em multi-projeto, o histórico de cada projeto pode estar em repos distintos — analise cada um.
6. Depois de pontuar as duas seções e ANTES de gerar o arquivo final, **faça as perguntas complementares ao DL e aguarde a resposta** (formato e conteúdo no fim deste prompt, subseção "Apresentação das perguntas no chat"). As perguntas são um **gate**: você ainda não salvou nada. **Meio preferencial:** se o ambiente oferecer uma ferramenta de perguntas interativas (perguntas com opções clicáveis — o Claude Code oferece), **use-a** — o DL responde clicando, e as respostas vêm estruturadas, mais fáceis de incorporar. Escreva também as perguntas por extenso no chat como acompanhamento (para o DL ver todas de uma vez e para servir de registro). Se a ferramenta interativa não estiver disponível, apresente as perguntas só em texto no chat, numeradas. Em ambos os casos, **encerre o turno** aguardando a resposta.
7. **Só depois que o DL responder**, incorpore as respostas nos scores e na análise (ex: `Spec & Planning = 0` só se confirma se o DL disser que não há planejamento estruturado; a trava de autonomia do Harness só reavalia com a confirmação do DL), e **então** gere e salve o relatório no caminho da seção Output (padrão `.github/audits/results/_summary/ai-fluency-report.md`) — já com a seção "## Respostas do DL" preenchida e o carimbo "✅ Relatório complementado com respostas do DL em [data]" no topo. Não adicione ao `.gitignore` — o DL decide se quer commitar.

> **Por que o gate vem antes de salvar:** garante que (a) o modelo de fato interage no chat (o arquivo só existe depois da resposta, então não há como "concluir" pulando a pergunta), e (b) o DL não recebe um relatório pela metade nem o repassa sem ter respondido — o artefato nasce já completo, com respostas embutidas.
>
> **Execução headless/não-interativa (cron):** se o ambiente não tem chat nem ferramenta interativa (pipeline automatizado), o gate degrada — gere e salve o arquivo direto, com as perguntas em aberto na seção "## Perguntas Complementares" (comportamento de fallback). Ordem de preferência dos meios: (1) ferramenta de perguntas interativas + texto no chat; (2) só texto no chat; (3) headless → arquivo direto com perguntas em aberto. Use sempre o nível mais alto disponível. Em qualquer execução interativa (o DL rodando na IDE), o gate é obrigatório.

## Modo Rescan (quando já existe um scan anterior)

Antes de começar, verifique se há um `ai-fluency-report.md` na raiz do workspace (ou apontado pelo DL). **Se houver, você está num rescan** — o objetivo deixa de ser só medir e passa a ser medir *e mostrar a evolução* desde o scan anterior. Se não houver, é a primeira medição: ignore este bloco e rode normal.

### O que fazer no rescan

1. **Leia o relatório anterior** e extraia: a data, os scores das duas seções (Fundamentos por dimensão + total; Harness H1-H5 + total), os níveis, e as travas ativadas.
2. **Levante o que mudou no intervalo** com git: `git log --since=<data-do-scan-anterior>` para ver commits, arquivos novos, artefatos que apareceram/sumiram (novas stories, ADRs, retros, hooks, configs). Este é o insumo que distingue evolução real de reavaliação.
3. **Marque Δ em cada dimensão** nos dois scorecards (coluna `Δ vs <data>`: `=`, `▲ +N`, `▼ −N`) e escreva um **resumo do delta** no topo (o que subiu, o que caiu, o que ficou estável, e a mudança de nível se houver).
4. **Para cada dimensão que mudou de score, classifique a causa** numa destas três — e declare qual foi, com a evidência:

   - **Evolução real:** o time mudou; há evidência material no repo desde a data anterior (commit, arquivo, artefato novo). → **Atualiza o score.** Ex: "H3 1→2: segunda retro (STORY-009) com proposta aplicada, arquivo `.sdd/retro/STORY-009-*.md` datado de [x]."
   - **Correção de scan anterior:** o time **não** mudou, mas o scan anterior **errou** e há evidência objetiva que ele ignorou. → **Atualiza o score, marcando que é correção** (não evolução). Ex: "Contexto 3→2 (correção): o scan anterior pontuou Avançado, mas o CLAUDE.md é genérico do framework; o específico está só no PROJECT-CONSTITUTION — critério de Avançado não era atendido."
   - **Reavaliação de fronteira:** o time não mudou, não há erro objetivo no anterior, o julgamento apenas pendeu para o outro lado num caso ambíguo. → **Mantém o score anterior por padrão** e registra a divergência como nota, sem sobrescrever. Ex: "MCP segue 2 (mantido): à luz do critério eu tenderia a 1, mas sem mudança material nem erro claro no anterior, preservo o score para não introduzir ruído na série; nota para reavaliar no próximo ciclo."

   > A linha entre **correção** e **reavaliação** é objetividade: correção aponta um fato que o scan anterior deixou passar; reavaliação é só o fiel da balança em caso ambíguo. **Só correção e evolução sobrescrevem o número.** Reavaliação preserva a série.

5. **Não rebaixe um time sem evidência material ou erro apontável.** A série histórica é o ativo — um score que oscila por capricho de julgamento destrói a confiança do DL no instrumento. Na dúvida entre reavaliar para baixo e manter, mantenha e registre a nota.

> **Observação para o teste de calibração entre modelos:** se este rescan roda com um modelo diferente do scan anterior (ex: Sonnet relendo um relatório feito com Opus), divergências de julgamento devem aparecer como **reavaliação de fronteira** (score mantido + nota), não como falso delta. Isso torna a diferença entre modelos visível e explícita, em vez de disfarçada de evolução do time.

---

# SEÇÃO 1 — FUNDAMENTOS

> Esta seção é idêntica à versão anterior do scan. **Não altere critérios, níveis ou o cálculo do score /15.** Ela sustenta a série histórica dos times. Tudo que muda nesta v2 está na Seção 2.

## Dimensão 1: Ambiente & Stack

### O que procurar:

Detecte a(s) IDE(s) e ferramenta(s) de IA configuradas no projeto:

| Arquivo/Diretório | Indica |
|-------------------|--------|
| .cursor/ ou .cursorrules | Cursor |
| .cursor/rules/ (diretório com .mdc ou .md) | Cursor com rules segmentadas |
| .vscode/ | VS Code |
| .idea/ | JetBrains (IntelliJ, Rider, etc.) |
| .windsurfrules | Windsurf |
| CLAUDE.md ou .claude/ | Claude Code |
| .github/copilot-instructions.md | GitHub Copilot |
| .github/instructions/ | GitHub Copilot com instruções segmentadas |
| GEMINI.md | Gemini CLI |
| AGENTS.md | Codex CLI / OpenAI |
| .augment/ | Augment Code |

Detecte as linguagens/frameworks principais:

| Arquivo | Indica |
|---------|--------|
| package.json | JavaScript/TypeScript (leia para verificar framework: React, Vue, Angular, Node, etc.) |
| tsconfig.json | TypeScript |
| *.csproj ou *.sln | .NET / C# |
| pom.xml ou build.gradle | Java |
| go.mod | Go |
| requirements.txt ou pyproject.toml ou Pipfile | Python |
| Cargo.toml | Rust |
| Gemfile | Ruby |
| composer.json | PHP |
| mix.exs | Elixir |
| pubspec.yaml | Dart/Flutter |

### Como avaliar:

- Liste todas as IDEs/ferramentas de IA detectadas
- Liste as linguagens e frameworks principais
- Classifique o suporte de IA para o stack detectado:
  - **Alto:** TypeScript, Python, JavaScript, Go, Rust — ecossistema de IA maduro, ferramentas e modelos performam bem
  - **Médio:** Java, C#/.NET moderno, Ruby, PHP, Kotlin — suporte bom mas com gaps em tooling específico
  - **Baixo:** COBOL, Fortran, Delphi, .NET Framework legado, linguagens de nicho — IA funciona com fricção significativa
- Se há múltiplas ferramentas de IA detectadas, note se parecem complementares (ex: Cursor + Claude Code) ou fragmentadas (configs conflitantes, desatualizadas)
- Estime a idade do sistema usando esta sequência (pare no primeiro que funcionar):
  1. Leia o arquivo LICENSE (ou LICENSE.md, LICENSE.txt) — procure o ano no texto (ex: "Copyright (c) 2019")
  2. Leia o arquivo CHANGELOG.md (ou CHANGELOG, HISTORY.md) — procure a data da entrada mais antiga
  3. Se git estiver disponível (ele é permitido na Seção 2), use a data do **primeiro commit** como estimativa de idade: `git log --reverse --format=%as | head -1`. Registre-a como a idade estimada — é uma fonte legítima, não apenas referência. Note no campo que a origem foi o primeiro commit (ex: "Junho/2026 — primeiro commit do repositório").
  4. Só se **nenhuma** das três fontes acima resolver (sem LICENSE, sem CHANGELOG datado, e git indisponível/shallow) → deixe "Não identificado" e faça a pergunta fixa ao DL.

> **Não pergunte a idade ao DL quando o primeiro commit já a revela.** A pergunta fixa de idade só é disparada no caso 4. Se o git deu a data, o campo está resolvido — não gere a pergunta. A data do primeiro commit pode subestimar a idade real (código migrado de outro repo), então, se quiser, o relatório pode registrar "≥ [data] (primeiro commit; pode haver histórico anterior migrado)" — mas isso **não** reabre a pergunta ao DL, é só uma qualificação da estimativa.

**Checagem de segurança (alerta binário — não pontua no score):**

Verifique rapidamente se há secrets expostos à IA. Procure:

- Há arquivos .env commitados no repositório (sem estar no .gitignore)?
- Arquivos de configuração de IA (.cursorrules, CLAUDE.md, configs de MCP) contêm tokens, chaves de API, ou strings de conexão hardcoded?

Se encontrar qualquer um dos dois, inclua no relatório:

> ⚠️ ALERTA DE SEGURANÇA: Foram encontrados secrets potencialmente expostos à IA. [descreva o que encontrou]. Recomenda-se ação imediata.

**Como descrever o achado — nunca copie o valor.** Este relatório é um arquivo gravado na raiz do workspace, que o DL pode commitar ou repassar. Transcrever um secret para dentro dele **cria** a exposição que o scan veio medir, e num artefato mais compartilhável que o original. Portanto:

- Reporte **onde** (arquivo e linha), **qual variável** (o nome da chave) e **por que é risco** — nunca o valor, nem um trecho dele, nem uma versão truncada ou mascarada.
- **Calibre o risco em vez de alarmar.** Variável exposta ao cliente por design (ex.: prefixo `VITE_`/`NEXT_PUBLIC_`, que o bundler injeta no browser) **não** é secret: é config pública. Um `.env` rastreado contendo só essas variáveis é **risco latente** — a gravidade está no próximo secret que alguém adicione ao arquivo já versionado — e não vazamento consumado. Diga qual dos dois é o caso.
- Se o arquivo está rastreado no git, registre que adicioná-lo ao `.gitignore` **não** o destraqueia (`git rm --cached` é o passo que falta) — é o erro mais comum nesse achado.

Se não encontrar problemas, não mencione — ausência de alerta = tudo ok.

## Dimensão 2: Contexto Persistente de Projeto

### O que procurar:

Arquivos que fornecem contexto persistente ao agente de IA sobre o projeto:

- CLAUDE.md (raiz ou subdiretórios)
- .cursorrules (legado) ou .cursor/rules/*.mdc ou .cursor/rules/*.md
- .github/copilot-instructions.md e .github/instructions/*.md
- GEMINI.md
- AGENTS.md
- .windsurfrules
- Qualquer arquivo *.md na raiz ou em diretório dedicado (tipo /docs/ai/, /ai-context/, .ai/) que pareça ser instruções para IA

### Como avaliar (quando encontrar):

Leia o conteúdo e avalie:

- **Especificidade:** As instruções são concretas e verificáveis ("Use 2 espaços de indentação", "Rode npm test antes de commitar") ou vagas ("Escreva código limpo", "Siga boas práticas")?
- **Estrutura:** Usa headers/bullets organizados por tema ou é um bloco monolítico de texto?
- **Tamanho:** Está conciso (<200 linhas por arquivo) ou está inchado (>500 linhas)?
- **Relevância:** As instruções fazem referência ao stack real do projeto (nomes de libs, padrões de arquitetura específicos, convenções do time) ou são genéricas?
- **Cobertura:** Abrange os temas essenciais — stack, convenções, padrões de teste, estrutura de diretórios, regras de naming?

### Níveis:

- **Inexistente (0):** Nenhum arquivo de contexto encontrado
- **Inicial (1):** Arquivo existe mas é genérico, auto-gerado sem refinamento, ou desatualizado
- **Estruturado (2):** Arquivo com instruções específicas do projeto, bem organizado, tamanho adequado
- **Avançado (3):** Múltiplos arquivos segmentados por domínio/contexto (ex: frontend.md, backend.md, testing.md), com regras scoped por path quando a ferramenta suporta

## Dimensão 3: Spec & Planning Artifacts

### O que procurar:

Artefatos que indicam planejamento estruturado antes da execução com IA:

- Arquivos plan.md, spec.md, design.md ou similares em qualquer diretório
- Diretório /specs/, /design/, /docs/design/, /docs/specs/, /docs/adr/, /adr/
- Architecture Decision Records (arquivos com padrão NNN-*.md em diretório de ADRs)
- Arquivos de spec do spec-kit (.speckit/, spec.config.*)
- Diretório .kiro/ (AWS Kiro specs)
- Diretório .bmad/ (BMAD Method)
- Diretório .ai-native-kit/ (ou .sdd/ em versões antigas) e intent/specs/{id}/spec.bdd.md — ou specs/{id}/spec.bdd.md em instalações anteriores à SPEC-018 (AI-Native Kit)
- Qualquer arquivo markdown que contenha seções como "Requirements", "Acceptance Criteria", "Technical Design", "Implementation Plan"

### Como avaliar (quando encontrar):

- **Recência:** Os arquivos de spec/plan são recentes (nomes, conteúdo referenciando features atuais) ou são arqueologia do início do projeto?
- **Estrutura:** Seguem um template consistente ou cada um é formato livre?
- **Rastreabilidade:** Há referência cruzada entre specs e implementação (ex: spec menciona arquivo X, arquivo X existe)?
- **Granularidade:** São specs por feature/task ou um documento monolítico do projeto inteiro?

Caso não encontre NENHUM artefato de spec/planning: Esta é uma das dimensões mais importantes. Nas perguntas complementares, pergunte EXPLICITAMENTE ao DL:

- "O time usa o modo Plan da IDE (ex: modo Plan do Cursor, plan do Claude Code) antes de executar tarefas com IA?"
- "Os arquivos de spec/plan estão no .gitignore ou ficam em outro lugar (Notion, Jira, Confluence, etc.)?"

### Níveis:

- **Inexistente (0):** Nenhum artefato de planejamento encontrado
- **Inicial (1):** README com descrição do projeto, mas sem specs ou plans de tarefas
- **Estruturado (2):** Specs ou plans existem com estrutura consistente e são usados para features/tarefas
- **Avançado (3):** Workflow completo de spec → plan → task, com ADRs, templates padronizados, e rastreabilidade clara

## Dimensão 4: Skills & Templates Reutilizáveis

### O que procurar:

Artefatos que criam comportamentos reutilizáveis para agentes de IA:

- .claude/skills/ (Claude Code skills)
- .cursor/rules/ com arquivos que funcionam como templates de execução (não apenas regras, mas workflows: "quando eu pedir X, faça Y seguindo estes passos")
- Diretório .ai/tools/, .ai/workflows/, .ai/templates/
- Arquivos de prompt template versionados (ex: prompts/, ai-prompts/)
- custom_instructions/ ou similar
- Comandos slash versionados (ex: .claude/commands/, ou comandos do AI-Native Kit como /feature, /implement, /review, /retro)
- Snippets ou templates que são claramente para uso com IA (ex: templates de PR que incluem seção de review de código IA)

### Como avaliar (quando encontrar):

- **Escopo:** São genéricos ("gere testes") ou específicos do domínio ("gere testes de integração para os endpoints de pagamento seguindo o padrão X")?
- **Reutilização:** Parecem ser invocados recorrentemente ou são one-off?
- **Manutenção:** Há múltiplas skills/templates ou apenas uma tentativa abandonada?

### Níveis:

- **Inexistente (0):** Nenhum skill ou template encontrado
- **Inicial (1):** 1-2 templates genéricos, pouco específicos
- **Estruturado (2):** Skills/templates específicos do projeto cobrindo tarefas recorrentes (testes, refactoring, criação de componentes)
- **Avançado (3):** Biblioteca de skills organizada por domínio, com documentação de quando usar cada uma

## Dimensão 5: MCP & Integrações Externas

### O que procurar:

Configurações que conectam o agente de IA a ferramentas externas:

- .cursor/mcp.json ou mcp.json
- .claude/settings.json (seção mcpServers)
- .vscode/mcp.json
- mcp-config.json, mcp-servers.json
- Referências a MCP em qualquer arquivo de configuração
- .claude/settings.json com seção de hooks (pre-commit, post-commit, etc.)

### Como avaliar (quando encontrar):

- **Quais MCPs:** Liste os servidores configurados (GitHub, Slack, Jira, banco de dados, Figma, etc.)
- **Relevância:** Os MCPs fazem sentido para o contexto do projeto? (ex: MCP de DB para um projeto com banco, MCP do Jira para gestão de tarefas)
- **Hooks:** Há hooks configurados para automação (ex: lint automático, validação pré-commit)?
- **Segurança:** Há deny lists ou restrições de permissão configuradas?

### Níveis:

- **Inexistente (0):** Nenhuma configuração de MCP ou integração encontrada
- **Inicial (1):** 1-2 MCPs básicos (ex: apenas filesystem ou search)
- **Estruturado (2):** MCPs relevantes para o workflow do projeto (GitHub + Jira/Linear + DB, por exemplo), com permissões configuradas
- **Avançado (3):** MCPs integrados ao workflow com hooks, deny lists, e uso estratégico (não é "plugou tudo que existe", é "plugou o que faz sentido e protegeu o resto")

## Dimensão 6: Validação & Qualidade

> **Nota de leitura para a Seção 2:** esta dimensão é, na prática, o inventário de **harnessability** do projeto — o quanto o código é *instrumentável*. Testes, tipagem, CI e linting são o que permite pendurar sensors. Um score baixo aqui é um teto físico para o harness: sem teste confiável não há sensor de teste, sem tipagem estrita perde-se um sensor grátis, sem fronteiras de módulo não há regra de arquitetura. A Seção 2 lê esse score antes de recomendar qualquer guide/sensor.

### O que procurar:

- .github/workflows/ ou .gitlab-ci.yml ou azure-pipelines.yml ou Jenkinsfile ou .circleci/ (CI/CD)
- Configuração de linting (.eslintrc*, .prettierrc*, biome.json, .editorconfig, ruff.toml, .flake8, pylintrc, stylecop.json)
- Configuração de testes (diretórios test/, tests/, __tests__/, spec/, arquivo jest.config.*, vitest.config.*, pytest.ini, xunit.*)
- Tipagem estática (tsconfig.json com strict, mypy.ini, .flowconfig)
- Security scanning (.snyk, trivy.yaml, dependabot config, .github/dependabot.yml)
- .github/pull_request_template.md (indica processo de review)
- CODEOWNERS (indica ownership e review obrigatório)

### Como avaliar:

- CI existe e roda? Procure workflows/pipelines. Leia brevemente para ver se incluem steps de test, lint, build.
- Testes existem? Verifique se há arquivos de teste reais (não só config). Estime grosseiramente a proporção de arquivos de teste vs. arquivos de código.
- Tipagem é usada? Se TypeScript, verifique se strict mode está ativo. Se Python, verifique se há mypy ou similar.
- Review tem estrutura? PR template + CODEOWNERS = indicativo de processo.

### Níveis:

- **Inexistente (0):** Sem CI, sem testes, sem linting
- **Inicial (1):** CI básico (build), poucos testes, linting parcial
- **Estruturado (2):** CI com lint + test + build, cobertura razoável de testes, tipagem estrita, PR template
- **Avançado (3):** CI completo com security scanning, CODEOWNERS, tipagem estrita, boa cobertura de testes, gates de qualidade que bloqueiam merge

## Score da Seção 1

Gere o scorecard e o nível de fluência **exatamente como na versão anterior** (não muda):

**Passo 1:** Some as 5 dimensões (Contexto, Spec, Skills, MCP, Validação) → score total /15.

**Passo 2:** Faixas:
- 0-3: 🔴 Básico
- 4-7: 🟡 Intermediário
- 8-11: 🟢 Avançado
- 12-15: 🔵 Fluente

**Passo 3:** Travas.

**Trava de IA** — some Contexto + Spec + Skills + MCP:
- 0-2 → teto 🔴 Básico
- 3-5 → teto 🟡 Intermediário
- 6-8 → teto 🟢 Avançado
- 9-12 → sem teto

**Trava de Validação** — score isolado de Validação & Qualidade:
- 0 ou 1 → teto 🟢 Avançado (nunca Fluente)
- 2 ou 3 → sem teto

**Passo 4:** O nível de Fundamentos = o **menor** entre a faixa do Passo 2, o teto da trava de IA, e o teto da trava de Validação. Se alguma trava ativar, adicione: "⚠️ Score total [X]/15, porém [explicação da trava] — nível de Fundamentos limitado a [nível]." (Na v2, nomeie sempre "nível de Fundamentos"; "geral/final" era o rótulo da v1.)

---

# SEÇÃO 2 — HARNESS

> O harness é o circuito de controle que torna o trabalho com agentes de código confiável e escalável. Fowler o descreve em dois eixos: **guides** (feedforward — alimentam o agente *antes/durante*) e **sensors** (feedback — validam *depois* e realimentam a autocorreção); cruzados por **computational** (determinístico, barato, roda sempre) vs **inferential** (semântico, caro, roda seletivamente). Um harness saudável fecha o loop: guides sem sensors = o agente nunca descobre se acertou; sensors sem guides = o agente repete o mesmo erro.
>
> A Seção 2 mede cinco dimensões (H1-H5) na **mesma escala 0-3** e com os **mesmos nomes** da Seção 1 (Inexistente/Inicial/Estruturado/Avançado). Cada dimensão traz uma **régua** com critério por nível e uma **coluna de evidência** (o que comprova aquele nível no repo). O princípio-guia: *o que não está em arquivo não existe* — mas a evidência é lida pelo conteúdo, nunca pela mera presença.

## Princípio transversal — Harnessability antes de harness

Vários times não têm harness baixo por falta de esforço, e sim por **falta de fundação onde ancorá-lo**. Sem suíte de teste confiável não há sensor de teste; sem lint/build configurado o hook de push não tem o que chamar; sem fronteiras de módulo não há regra de arquitetura. Nesses casos, o nível baixo de H2/H4/H5 é um **gap de harnessability**, não de harness — e a recomendação correspondente aponta para a **dívida técnica a saldar primeiro** (que a Dimensão 6 da Seção 1 já mapeou), não para "adicione um sensor". As réguas abaixo marcam explicitamente, nos níveis baixos, quando o gap é de fundação.

## Uso de git na Seção 2

Git é permitido aqui, com estas regras:

- **Evidência primária de H3 (Steering loop):** a evolução datada dos arquivos de harness é o sinal mais difícil de falsificar. Um CLAUDE.md que nasceu e nunca mudou em meses de commits ativos é harness morto — e só o histórico revela isso. Use `git log --follow` nos arquivos de harness (CLAUDE.md, .cursor/rules/, hooks, skills, eval suites) para ver se evoluem.
- **Qualificador nas demais dimensões, nunca contador:** git pode *rebaixar a confiança* de um nível (ex: muitos guides no repo, zero uso observável no histórico → nota de cautela), mas **não soma nem subtrai pontos** por contagem de commits, co-autoria, ou cadência. Não transforme "N commits com Co-authored-by" em pontos — isso é trivialmente gameável e vira métrica de vigilância.
- **Degrada graciosamente:** se o clone é raso (shallow) ou o git não está disponível, registre "histórico indisponível" e avalie H3 só pelos artefatos presentes (eval suite, changelog do harness, drift reports). Não penalize o time pela ausência do histórico.
- **Nota de divergência:** quando os sinais de arquivo e de histórico divergirem (setup rico, uso ausente — ou o inverso), adicione uma nota textual pontual no lugar relevante ("configuração presente, sem uso observável no histórico — validar com o DL"). Sem selo permanente; ausência de nota = sem divergência.

## Regra de versionamento — Hyperion (substitui a regra do AI-Native Kit)

O instrumento original manda gitignorar comandos, hooks e `CLAUDE.md` do framework. **No Hyperion isso está errado.** Prevalece o seguinte:

- **Artefatos do PROJETO — devem ser versionados:** cards, specs, planos, ADRs, discoveries, `memory/`, `project.yml`. Se estiverem fora do git, isso é gap.
- **Artefatos do FRAMEWORK Hyperion — também devem ser versionados:** `.github/skills/`, `CLAUDE.md`, `.cursor/rules/`, `scripts/hyperion/`, `scripts/cards-sync/`. O `hyperion:upgrade` gerencia esses arquivos. **Nunca recomende gitignorá-los.**
- **Workflows de produto** em `.github/workflows/` vêm do `/pipeline` (templates renderizados), não de uma cópia do CI do repositório do kit. Achar `hyperion-validate.yml` rodando `distribution-purity-check`, `hyperion-docker-publish.yml`, `hyperion-e2e-cards.yml`, ou um `hyperion-sync-cards.yml` só `workflow_dispatch` dentro de um produto é workflow vazado de um upgrade antigo. Recomende `npm run hyperion:doctor` e a limpeza que ele imprime (`git rm` desses arquivos, depois `npm run hyperion:pipeline-apply -- --yes`). Não trate esse vazamento como higiene.
- Um harness Hyperion commitado **não perde pontos** em H1/H3 por estar no git. Avalie steering pelos artefatos de projeto (memória, ADRs, retros, `audit-diff`) e pela evolução dos skills, não pela ausência dos scripts.

## Guides (feedforward)

**O que orienta o agente ANTES de agir.** Skills, comandos, agents (planner, subagents read-only), artefatos versionados, convenções, how-tos, acesso autônomo a contexto (MCPs), consumo de spec/plano como input. São as caixas *acima do flow* no vocabulário do harness.

**O que procurar (relê o que a Seção 1 achou + acrescenta):**
- Guides **inferenciais**: skills, rules (.cursor/rules, CLAUDE.md), comandos slash (/feature, /plan, /brownfield), agents especializados, personas, convenções versionadas.
- Guides **computacionais**: scripts de bootstrap de contexto (ex: context-bootstrap hook que injeta memória do projeto), codemods, LSP configurado, geradores de scaffold.
- Consumo de spec/plano como input no momento da geração (o guide chega *antes* do código, não depois).

**Sub-leitura obrigatória:** classifique os guides encontrados em computacionais vs inferenciais. A maioria dos times só tem inferenciais e acha que tem harness — registre isso.

### Régua — Guides

| Nível | Critério | Evidência |
|---|---|---|
| **Inexistente (0)** | IA opera "no escuro". Sem contexto versionado, sem skills, sem convenções. Cada dev re-explica tudo a cada sessão via prompt manual. | Ausência de CLAUDE.md/rules/skills/comandos versionados no repo. |
| **Inicial (1)** | Existe algum guide, mas o conjunto é incompleto ou genérico. Pelo menos um furo: (a) contexto autônomo (MCP) sem skills/convenções versionadas; (b) convenções versionadas mas contexto limitado; (c) tudo configurado mas a IA não consome spec/plano como input (gera a partir do título do card ou da memória do dev). | 1 arquivo de contexto genérico OU config técnica presente sem consumo de spec/plano observável no último PR. |
| **Estruturado (2)** | Guides específicos do projeto, versionados, cobrindo contexto + convenções, usados de forma recorrente. A IA gera código referenciando padrões do projeto sem re-explicação a cada sessão. | Skills/rules específicas versionadas + último PR mostrando IA seguindo convenções do projeto sem prompt manual de contexto. |
| **Avançado (3)** | Guiado de ponta a ponta, com guides computacionais **e** inferenciais. Três guides ativos: acesso autônomo ao contexto (MCPs/equivalentes), skills/convenções versionadas orientando *como* gerar, e consumo de spec+plano como input no momento da geração. Guides segmentados por domínio quando faz sentido. | Guides presentes e em uso (bootstrap de contexto + convenções + spec/plano como input) + PR recente com IA gerando a partir de spec/plano explícitos. **No Hyperion os scripts do kit commitados contam a favor** — ver "Regra de versionamento"; gitignorar `.github/skills/` ou `CLAUDE.md` é gap, não higiene. O que conta é o uso. |

---

## Sensors (feedback)

**O que valida DEPOIS e realimenta a autocorreção.** Hooks (pre-push, validate-spec, secrets), linters com mensagem otimizada para LLM, review agents (tipo @diff-critic), testes unitários/integração/E2E como sensores mecânicos, testes estruturais/arquiteturais, smoke pós-deploy. São as caixas *abaixo do flow*.

**O que procurar (relê o que a Seção 1 achou + acrescenta):**
- Sensors **computacionais**: hooks de git (.husky/, lefthook.yml, .claude/settings.json com hooks, PreToolUse), lint/tsc/build no push, testes que rodam antes do push, secret scanning, dead-code detection.
- Sensors **inferenciais**: AI code review no diff (review agent), avaliadores céticos, análise semântica de PR.
- **Sinal otimizado para LLM:** o sensor devolve erro cru, ou devolve sinal acionável que realimenta o agente automaticamente (a "prompt injection do bem")? Procure realimentação automática com cap de tentativas.

**Sub-leitura obrigatória:** classifique em computacionais vs inferenciais, e registre se o sinal realimenta o agente ou só cospe erro.

> **Nota sobre hooks e a Dimensão 5 (MCP):** hooks são avaliados **aqui**, em Sensors (H2), como sensor computacional. A Dimensão 5 da Seção 1 menciona hooks no texto por herança da v1 (série histórica congelada) — **não os recontabilize como reforço do score de MCP**. Onde os hooks pesam é em H2/H4/H5; em MCP entram, no máximo, como contexto qualitativo, nunca como duplo peso.

### Régua — Sensors

| Nível | Critério | Evidência |
|---|---|---|
| **Inexistente (0)** | Nenhum controle de feedback automatizado antes do humano. **Frequentemente gap de harnessability:** sem teste, sem lint configurado, não há de onde emitir sinal. Se for esse o caso, marque como fundação ausente. | Sem hooks, sem testes reais, sem lint no repo. (Cheque a Dimensão 6 da Seção 1 para confirmar se é fundação ausente.) |
| **Inicial (1)** | Sensors existem mas com furos. Pelo menos um: (a) cobertura parcial (só lint, ou lint+tsc sem build); (b) config não uniforme (cada dev configura do seu jeito, não versionada); (c) bypass fácil (--no-verify aceito sem registro); (d) feedback manual (dev copia/cola erro pra IA; não há realimentação automática). Testes existem mas não são confiáveis o suficiente para sustentar autocorreção. | Hook parcial OU testes sem gate OU lint só na IDE. Flake rate alto ou suíte que o time não confia. |
| **Estruturado (2)** | Sensors computacionais confiáveis rodando em ponto definido (pre-push e/ou CI), suíte de teste em que o time confia, e ao menos um sensor que devolve sinal acionável. O agente se autocorrige na maioria dos casos comuns. Config versionada e uniforme. | Hook versionado (lint+tsc+build) instalado uniformemente + log recente de hook bloqueando push real + suíte de teste com pass rate estável. |
| **Avançado (3)** | Sensors computacionais **e** inferenciais combinados (ex: hooks mecânicos + AI code review), distribuídos por custo, com sinal otimizado para consumo do LLM e realimentação automática com cap de tentativas. Testes estruturais/arquiteturais presentes quando o stack permite. Pegam classes de erro reais antes do humano. | Config versionada de hooks + review agent com ciclo/cap/critérios versionados + log de realimentação automática em PR recente + testes de arquitetura (ArchUnit/layered-arch/equivalente). |

---

## Steering loop (o harness evolui?)

**O meta-circuito que mantém o harness vivo.** Fowler chama de governador cibernético: o harness que não se ajusta envelhece e drifta do código real. É o que separa um harness *vivo* de um *snapshot morto*.

**O que procurar:**
- Eval suite que roda em ritmo, testando agents/guides contra casos canônicos (ex: presentation de eval, specs canônicas).
- Drift detection: mecanismo que verifica se guides/skills/regras ainda batem com o código real (tipo drift-janitor, ou um /retro que propõe mudanças ao playbook).
- Constitution/playbook versionado que **evolui** (v1→v2→v3), CHANGELOG do harness, PRs tipo `chore: harness-drift-report`.
- Caminho explícito de aprendizado: incidente em produção → revisão do harness (novo sensor, nova regra), com decisão registrada mesmo quando é "nada muda".
- Logging de sessão/fricção que alimenta retrospectiva (retro-logger, session metrics).

**Git é evidência primária aqui** (ver regras de git acima). Compare a data de nascimento dos arquivos de harness com a atividade recente do repo.

### Régua — Steering loop

| Nível | Critério | Evidência |
|---|---|---|
| **Inexistente (0)** | Harness (se existe) foi configurado uma vez e ficou. Nenhum mecanismo verifica se os agents ainda performam, se os guides batem com o código, se as regras fazem sentido. Incidentes viram fix de código, nunca mudança no harness. Envelhece silenciosamente. | Nenhuma eval suite, nenhum drift detection; `git log` mostra arquivos de harness estáticos desde a criação, apesar de repo ativo. |
| **Inicial (1)** | Há algum aprendizado, mas ad-hoc e irregular. O harness até evolui, mas por iniciativa individual, sem caminho sistemático. Sem eval, sem drift detection automático. | Alterações esporádicas nos guides no `git log`, sem eval/drift versionados; mudanças dependem de alguém lembrar. |
| **Estruturado (2)** | Existe mecanismo de aprendizado com alguma regularidade: retrospectiva que propõe melhorias ao harness, ou eval rodando periodicamente, ou drift check. O harness é tratado como artefato mantido. | Comando/processo de retro versionado + histórico de mudanças nos guides ligadas a aprendizado + pelo menos um registro de revisão. |
| **Avançado (3)** | Harness aprende ativamente. Eval suite roda em ritmo (diário/semanal) e alerta em degradação. Drift detection marca divergências entre guides e código. Aprendizado de incidente tem caminho explícito e decisão registrada. | Eval suite versionada + log de execuções + config de drift detection + registro de incidente que gerou (ou decidiu não gerar) mudança no harness. |

---

## Distribuição temporal (keep quality left)

**O harness distribui os controles por custo?** Fowler: controle barato e determinístico à esquerda (pre-commit/pre-push), controle caro e semântico à direita (pipeline). Mede se o time entende custo e onde cada controle roda.

**O que procurar:**
- Sensors computacionais baratos no pre-push (lint, tsc, testes rápidos) e sensors caros/redundantes no CI (E2E full, security, review inferencial).
- Redundância intencional (os mesmos checks no push *e* no CI em ambiente limpo).
- Anti-padrões: tudo jogado só no pipeline (perdeu o shift-left), ou controle caro no pre-push (mutation testing/E2E full travando cada push), ou nada à esquerda.
- Sinais de otimização de custo (ex: model-advisor escolhendo modelo por tarefa, concise mode reduzindo verbosidade) contam como maturidade de distribuição de recurso.

### Régua — Distribuição temporal

| Nível | Critério | Evidência |
|---|---|---|
| **Inexistente (0)** | Não há distribuição — não há controles (ver H2/harnessability), ou existe um único ponto sem critério. | Sem hooks e sem pipeline, ou só um dos dois sem separação de custo. |
| **Inicial (1)** | Controles existem mas mal distribuídos. Anti-padrão presente: tudo no CI (nada à esquerda), ou controle caro no pre-push travando o fluxo, ou o pre-push não roda de verdade. | Pipeline sem hook local, OU hook local rodando suíte pesada, OU checks duplicados sem propósito. |
| **Estruturado (2)** | Barato à esquerda, caro à direita, com lógica clara. Pre-push roda lint/tsc/build/testes rápidos; CI roda o pesado em ambiente limpo. | Hook de push versionado com checks rápidos + pipeline com E2E/security + separação visível de responsabilidade. |
| **Avançado (3)** | Distribuição sofisticada: redundância intencional (push + CI limpo), controles caros e inferenciais posicionados onde o custo se justifica, e sinais de otimização de recurso (modelo por tarefa, verbosidade controlada). | Config de hooks + pipeline mostrando o mesmo core redundante em ambiente limpo + posicionamento deliberado do inferencial no PR + evidência de gestão de custo de tokens/modelo. |

---

## Circuito de auto-correção e gates

**Quanto o harness sustenta execução autônoma — via mecânica, não vigilância.** Caps de tentativa antes de escalar para humano, gate mecânico (não revisão síncrona) sem bypass, auto-aprovação de plano para tarefa rotineira, realimentação automática de falha para o agente. É a capacidade estrutural que **habilita** delegar com segurança (distinto de *delegar de fato* — ver nota de autonomia).

**O que procurar:**
- Cap de tentativas de autocorreção (ex: 2-3 tentativas → escala pro humano), como em run-and-validate ou fix-ci-cap.
- Gate mecânico que bloqueia progresso (ex: process-guard bloqueando /review sem /sync; pre-push sem bypass; branch policy bloqueando merge sem override).
- Auto-aprovação de plano para delegação rotineira (throughput muda gates).
- Realimentação automática: falha do sensor volta pro agente sem ação manual do dev.
- Distinção entre "harness completo e humano confia" vs "harness completo mas humano revisa tudo por hábito/desconfiança".

### Régua — Circuito de auto-correção e gates

| Nível | Critério | Evidência |
|---|---|---|
| **Inexistente (0)** | Nenhum circuito de autocorreção. O agente age, o humano revisa tudo manualmente. Sem cap, sem gate mecânico, sem realimentação. | Ausência de caps, hooks bloqueantes, ou realimentação automática no repo. |
| **Inicial (1)** | Gates existem mas frágeis ou parciais. Bypass fácil, ou sem cap, ou realimentação manual (dev copia erro pra IA). Humano é forçado a duplicar o que o harness deveria fazer. | Hook bypassável, ou gate sem realimentação, ou cap ausente. |
| **Estruturado (2)** | Gate mecânico confiável sem bypass fácil + realimentação automática ao agente com cap definido. O agente se autocorrige em loop e só escala ao humano quando atinge o cap ou quando a falha indica decisão (não bug). | Hook/pipeline bloqueante versionado + cap documentado + log de ciclo de retry automático em PR recente. |
| **Avançado (3)** | Circuito completo e confiável: caps + gates mecânicos + auto-aprovação de plano para rotina + realimentação automática, **com convenção de divisão de responsabilidade documentada e operante** (harness cobre mecânica/padrões/segurança óbvia; humano cobre intent/UX/domínio). Resultado observável: humano filtra com confiança, revisa só o que importa. | Todos os gates verdes + cap + convenção documentada + comentários humanos em PRs concentrados em intent/domínio (sinal de filtragem real), não em mecânica. |

---

## Matriz Guides × Sensors (lente diagnóstica — NÃO pontua)

Depois de avaliar H1 e H2, posicione os artefatos encontrados nas quatro células. Isto **não gera nota** — serve para revelar assimetrias que a soma esconde.

|  | **Computacional** (determinístico, barato) | **Inferencial** (semântico, caro) |
|---|---|---|
| **Guides** (feedforward) | bootstrap de contexto, codemods, LSP, scaffold | skills, rules, comandos, agents, personas |
| **Sensors** (feedback) | hooks lint/tsc/build, secret scan, testes mecânicos | AI code review, avaliador cético, análise semântica de PR |

**Alertas de assimetria a emitir (quando aplicável):**
- **Só guides, sem sensors:** "O agente é orientado mas nunca verificado — não descobre se as regras funcionaram. Risco de erro silencioso repetido."
- **Só sensors, sem guides:** "O agente é corrigido mas não orientado — repete o mesmo erro a cada tarefa porque nada o guia antes."
- **Só computacional:** "Controles determinísticos sem camada semântica — pega erro de forma mas não de intenção/design."
- **Só inferencial:** "Controles semânticos sem base determinística — caro, lento, e sem a rede de segurança barata que deveria rodar sempre."

---

## Score da Seção 2 — Harness

**Passo 1:** Some H1-H5 (cada 0-3) → total /15. Sem pesos: as cinco dimensões valem igual; as travas fazem o trabalho de impedir inflação.

**Passo 2:** Faixas (mesmos nomes da Seção 1):
- 0-3: 🔴 Básico — harness ad hoc ou inexistente
- 4-7: 🟡 Intermediário — peças presentes, circuito incompleto
- 8-11: 🟢 Avançado — circuito de controle consistente
- 12-15: 🔵 Fluente — harness cibernético, sustenta autonomia real

**Passo 3:** Travas (o nível final é o **menor** entre a faixa e todos os tetos ativados).

**Trava de simetria** (vem direto de Fowler — meio-circuito não é harness maduro):
- Se H1 (guides) ≥ 2 e H2 (sensors) = 0, **ou** H2 ≥ 2 e H1 = 0 → **teto 🟡 Intermediário**. O agente ou nunca descobre se acertou, ou repete o mesmo erro. Um lado sem o outro não sobe a Avançado.

**Trava de steering** (harness morto não é fluente):
- Se H3 (steering loop) = 0 → **teto 🟢 Avançado, nunca Fluente**. Um harness que nunca evolui é decoração sofisticada, não um governador cibernético.

**Trava de autonomia** (autonomia é pré-requisito de Fluente, não um segundo farol):
- **Fluente exige** circuito maduro **E** evidência de que ele sustenta execução autônoma real: H5 (auto-correção e gates) = 3 **e** confirmação (no repo ou pelo DL) de que o time de fato delega execução com o harness segurando (auto-aprovação de plano em uso, ciclo Build-verde + Verify-verde entregando sem humano na maioria dos casos rotineiros).
- Se o circuito é maduro (faixa Fluente) mas H5 < 3 ou não há evidência de autonomia exercida → **teto 🟢 Avançado**. Delegar muito não faz Fluente; delegar sobre um harness que se autocorrige, sim. Autonomia é o teto do topo, não o piso.

> **Por que autonomia não é farol separado:** um time pode delegar 80% da execução sobre um harness ruim — isso é imprudência, não fluência. Em vez de reportar autonomia como um segundo número em paralelo, ela entra como a condição que separa Avançado de Fluente. O time que delega muito com harness fraco é corretamente classificado como Básico/Intermediário pelas outras dimensões e pela trava de simetria — o gap aparece explícito na análise de H5, sem precisar de um alerta à parte.

**Passo 4:** Se alguma trava ativar, adicione: "⚠️ Harness [X]/15, porém [explicação da trava] — nível de harness limitado a [nível final]."

---

## Formato do Relatório

Formato do `ai-fluency-report.md` (gerado e salvo **após** o gate de perguntas — ver passos 6-7).

> **Regras de formato do arquivo (contrato do parser — NÃO viole, é o que mantém a série histórica intacta):**
> 1. **Scorecards têm exatamente 3 colunas: `| Dimensão | Nível | Score |`.** O nome da dimensão SEMPRE na 1ª coluna; o dígito 0-3 SEMPRE na última. **Nunca** adicione coluna de índice (`#`) antes do nome, nem coluna extra (ex: Breakdown) depois do Score. O breakdown por projeto de workspace multi-projeto vai numa **nota sob a tabela**, nunca numa coluna.
> 2. **Linhas do scorecard de Harness começam com o rótulo `H1`..`H5`** no formato `H1 · Guides (feedforward)` (col 1). O parser ancora nesse rótulo.
> 3. **Nível resolvido da Seção 1** usa **sempre** o rótulo "**Nível de Fundamentos:**" seguido do nível na mesma linha (ex: "Nível de Fundamentos: 🟢 Avançado"). **Não** use "Nível final" nem "Nível geral" na v2 — esses eram os rótulos da v1 (o parser ainda os entende para ler relatórios antigos, mas a v2 nomeia por seção, porque agora há dois níveis). **Nível resolvido da Seção 2** usa **sempre** "**Nível de Harness:**". Cada seção tem seu rótulo próprio; nunca use o mesmo nas duas — é o que separa os dois níveis para o parser. O bloco de cálculo (faixa base + travas) vai sob um header "**Cálculo do nível ...**" separado, para o nível resolvido ficar numa linha única com o emoji.
> 4. **Idade:** mantenha o rótulo literal "**Idade estimada do sistema:**" e evite anos soltos ou "~N anos" no restante do cabeçalho e na Seção 2 (o parser varre anos e pode confundir com a idade do sistema).
> 5. **Headings narrativos** preservam os nomes "O que chamou atenção", "Gaps identificados" e "Top Recomendações" (o parser sincroniza highlight/gap por esses headings).
> 6. **Marcador de protocolo — obrigatório, e a forma exata importa.** Inclua no cabeçalho a linha literal `**Protocolo de scan**: v2.1` — com o dois-pontos **fora** do negrito. Diferente de todos os outros rótulos deste template (que usam `**Rótulo:**`), este o parser só reconhece nesta forma: `**Protocolo de scan:** v2.1` **não** casa. É por essa linha que ele resolve **qual revisão do instrumento** gerou o relatório; sem o marcador ele cai numa inferência estrutural e registra a revisão errada, embaralhando a série justamente onde a comparabilidade importa. Atualize o número quando a revisão do instrumento mudar.
> 7. **Ao declarar uma trava que NÃO ativou, não escreva "não ativa a trava de X".** O parser detecta trava ativa por padrões como `ativa a trava de X` e só procura ressalva ("não impacta", "sem efeito") *depois* do trecho casado — uma negação antes dele passa batido e a trava é lida como ativa. Prefira a forma sem o verbo: `Trava de steering: não se aplica (H3 = 1; exigiria 0)`.

```markdown
# 🔍 AI Fluency Scan — [Nome do Workspace]
**Data:** [data atual]
**Protocolo de scan**: v2.1
**Topologia:** [Repo único / Multi-projeto em pastas / Monorepo] — [N projetos: ex. web (React), api (.NET)]
**IDE(s) detectada(s):** [lista]
**Linguagens/Frameworks:** [lista por projeto]
**Suporte de IA do stack:** [Alto/Médio/Baixo] — [justificativa de 1 linha]
**Idade estimada do sistema:** [ano do LICENSE/CHANGELOG/primeiro commit — indicando a fonte; ou "Não identificado — aguardando DL" só se nenhuma fonte resolver]
**Kit de harness detectado:** [AI-Native Kit vX.Y.Z / "sdd-kit (geração anterior)" / "craft-ai (geração antiga)" / "não detectado"] — [se antigo ou sem número: nota de atualização, ver perguntas]

> Se multi-projeto: cada scorecard abaixo traz o **consolidado do workspace** (regra do pior elo qualificado). Quando há assimetria relevante, registre o **breakdown por projeto** numa **nota sob a tabela** (ex: "> Assimetria — Contexto: web 2 / api 1"), nunca como coluna.
> Se for **rescan** (havia relatório anterior): inclua logo abaixo do cabeçalho uma linha "**Rescan.** Segundo scan; anterior de [data] ([N] dias, [delta de commits/artefatos])." e um **resumo do delta**; adicione a coluna `Δ vs [data]` como **última** coluna dos scorecards (depois de Score) somente em rescan, e mantenha o dígito de Score na coluna Score.

---

## SEÇÃO 1 — FUNDAMENTOS

### Scorecard
| Dimensão | Nível | Score |
|---|---|---|
| Contexto Persistente | [nível] | [0-3] |
| Spec & Planning | [nível] | [0-3] |
| Skills & Templates | [nível] | [0-3] |
| MCP & Integrações | [nível] | [0-3] |
| Validação & Qualidade | [nível] | [0-3] |
| **TOTAL** | | **[X]/15** |

[Se multi-projeto com assimetria, uma nota por dimensão assimétrica, ex: "> Assimetria — Contexto: web 2 / api 1"]

**Cálculo do nível de Fundamentos:**
- Score total: [X]/15 → faixa base [🔴 Básico / 🟡 Intermediário / 🟢 Avançado / 🔵 Fluente]
- Trava de IA: soma das 4 dimensões de IA (Contexto+Spec+Skills+MCP) = [X]/12 → [teto aplicado, ou "sem teto"]
- Trava de Validação: score de Validação = [X] → [teto aplicado, ou "sem teto"]

**Nível de Fundamentos:** [🔴/🟡/🟢/🔵] [Básico/Intermediário/Avançado/Fluente] [se alguma trava ativou, acrescente na MESMA linha: "— limitado por [trava] (score bruto seria [faixa])"; senão: "(nenhuma trava ativada)"]

### Análise por Dimensão

[Dimensão 1 (Ambiente & Stack) é descritiva e não pontua — apresente como no v0. Para cada dimensão pontuável (2 a 6):]

**Score: [X]/3 — [Nível]**

**O que foi encontrado:**
[lista]

**O que chamou atenção (positivo):**
[destaques]

**Gaps identificados:**
[o que falta ou pode melhorar]

---

## SEÇÃO 2 — HARNESS

### Scorecard
| Dimensão | Nível | Score |
|---|---|---|
| H1 · Guides (feedforward) | [nível] | [0-3] |
| H2 · Sensors (feedback) | [nível] | [0-3] |
| H3 · Steering loop | [nível] | [0-3] |
| H4 · Distribuição temporal | [nível] | [0-3] |
| H5 · Circuito de auto-correção & gates | [nível] | [0-3] |
| **TOTAL** | | **[X]/15** |

[Se multi-projeto com assimetria, uma nota por dimensão assimétrica sob a tabela]

**Nível de Harness:** [🔴/🟡/🟢/🔵] [Básico/Intermediário/Avançado/Fluente]
[nota de trava, se ativada — usando "nível de harness limitado a ...", nunca "final/geral"]
[nota de harnessability, se o gap for de fundação: "Nota: os gaps de H[N] são de harnessability — a fundação (Dimensão 6 = [score]) precisa subir antes do harness."]

### Matriz Guides × Sensors
[Tabela 2×2 com os artefatos posicionados + alertas de assimetria emitidos]

### Análise por Dimensão

[Para cada dimensão (H1 Guides, H2 Sensors, H3 Steering loop, H4 Distribuição temporal, H5 Circuito de auto-correção & gates), use os mesmos cabeçalhos por extenso da Seção 1:]

**Score: [X]/3 — [Nível]**

**O que foi encontrado:**
[lista — com sub-leitura computacional vs inferencial em Guides e Sensors]

**O que chamou atenção (positivo):**
[destaques]

**Gaps identificados:**
[o que falta ou pode melhorar; nota de git quando houver divergência entre arquivo e histórico]

---

## Top Recomendações
[Até 5 ações de maior impacto considerando AMBAS as seções, ordenadas por prioridade. Uma lista única e consolidada — NÃO separe por seção. Cada item taggeia a(s) dimensão(ões) que endereça, ex: "(H2/H4/Dim 6)". Regras contextuais abaixo.]

1. **[Ação]** — [Por quê] — [Esforço: baixo/médio/alto]
...

---

## Perguntas Complementares
[Esta seção do ARQUIVO registra as perguntas em aberto (e, após resposta, vira "Respostas do DL"). Registrá-las aqui NÃO substitui apresentá-las no chat — ver passo 6 das instruções de execução. Conteúdo: pergunta fixa de idade, se aplicável + até 3 perguntas do scan de Fundamentos + perguntas de Harness — ver regras abaixo]

---

## Contexto para Interpretação
[Notas fixas: suporte de IA por linguagem, ausência de configs no repo, MCPs, Spec & Planning, e harnessability]
```

## Regras para recomendações

A seção **Hyperion adaptations** no topo desta skill substitui toda recomendação de instalar o AI-Native Kit. Não recomende esse kit, nem `craft-ai`, nem `sdd-kit`.

- **Spec & Planning = 0** e a pessoa confirma que não há planejamento estruturado → recomende `/explore` → `/spec` → `/implement` (spec versionada antes do código). Se Validação ≤ 1, a dívida técnica vem primeiro e o fluxo de spec é o passo 2. Se o harness já é Estruturado ou Avançado, recomende só o gap de planejamento.
- **Skills & Templates = 0** → aponte skills concretos em `.github/skills/` para o stack detectado, não um dump genérico de prompt.
- **MCP & Integrações = 0** → aponte `.github/mcp/servers.example.json` e só os servidores que o projeto usa (board, repo). Ausência de MCP não é gap automático.
- **Validação & Qualidade < 3** → recomendação obrigatória de harnessability, nas Top Recomendações, taggeada (ex.: `(Dim 6/H2/H4)`):
  - **≤ 1:** saldar a fundação primeiro (suíte de teste, linter versionado, tipagem estrita, CI com lint+test+build). `/pipeline` é o passo 2.
  - **= 2:** o degrau para Avançado — security scanning, CODEOWNERS, gate de cobertura que bloqueia merge.
- **Harnessability boa (Validação ≥ 2) + Harness Básico/Intermediário:** recomende completar o Hyperion, nomeando o buraco: guides (`/discover`, `/explore`, `/spec`, `/implement`, skills), sensors (`/doctor`, `/review`, `/pr-review`, CI do `/pipeline`), steering (`/retro`, `/audit`, `npm run hyperion:audit-diff`), gates (`/spec-review`, board guard, coverage gate).
- **Harness Estruturado/Avançado:** não empurre um segundo kit. Recomende o gap pontual (steering, sensor inferencial, cap de tentativa).
- **Assimetria front/back:** nivele o elo fraco. Prefira artefato compartilhado na raiz a configs duplicadas.
- **Versionamento:** siga a regra Hyperion acima. Nunca recomende commitar o CI do repositório do kit dentro de um produto, nem gitignorar skills/`CLAUDE.md`.


## Regras para perguntas complementares

- **Teto total: no máximo ~4 perguntas ao DL** (a pergunta fixa de idade **não** conta nesse teto). O "até 3" de Fundamentos e as perguntas de Harness **compartilham** esse teto — não são cotas separadas que se somam. Quando os gaps gerarem mais candidatas que ~4, priorize nesta ordem: (1) perguntas obrigatórias já marcadas (ex.: as duas de Spec & Planning quando Spec = Inexistente); (2) perguntas de Harness que **só o DL confirma** (autonomia exercida, uso real de sensors, destino de propostas de retro); (3) demais de Fundamentos por impacto. O que não couber vira nota/recomendação, não pergunta — "pergunta é cara, recomendação é barata".
- **Pergunta fixa (não conta no limite):** dispare-a **apenas** se a idade não foi identificada por nenhuma das três fontes (LICENSE, CHANGELOG, **nem primeiro commit do git**). Se o git revelou a data do primeiro commit, a idade está resolvida — **não pergunte**. Só quando as três falharem, pergunte o ano/mês de início do desenvolvimento.
- **Fundamentos (até 3):** perguntas específicas dirigidas pelos gaps. Se Spec & Planning = Inexistente, inclua obrigatoriamente as duas perguntas sobre modo Plan e localização dos specs (Notion/Jira/Confluence).
- **Harness (perguntas próprias, dirigidas pelos gaps que só o DL confirma):**
  - Se H3 baixo: "O harness (guides, sensors, regras) já foi revisado desde que foi criado? Existe algum ritual — retro, eval, revisão pós-incidente — que ajusta o harness?"
  - Se H5 alto mas sem evidência de autonomia exercida: "O time de fato deixa o agente executar tarefas rotineiras sem revisão manual completa, confiando nos gates? Ou revisa tudo à mão por hábito?"
  - Se sensors ricos mas não se observa se rodam: "Os hooks/sensors realmente rodam no fluxo de todos os devs, ou ficam desativados/bypassados na prática?"
  - Se muito guide no repo mas git mostra pouco uso: "As configs de harness no repo refletem o uso real, ou cada dev usa seu próprio setup no nível de usuário (~/.claude, ~/.cursor)?"

> **Não pergunte sobre versão do kit nem sobre versionamento do harness.** Ambos viram recomendação adicional (ver "Regra de versionamento" e a detecção de versão na Fase 0), não pergunta — o scan tem evidência suficiente para recomendar a ação sem depender da resposta do DL. Reserve as perguntas para o que só o DL sabe (autonomia exercida, MCP fiado em nível de usuário, destino das propostas de retro).

### Apresentação das perguntas no chat

**Depois de pontuar as duas seções — e ANTES de gerar o arquivo — apresente as perguntas e encerre o turno aguardando o DL.** Você ainda não salvou o relatório: as perguntas são o gate que precede o arquivo.

**Meio preferencial:** se houver ferramenta de perguntas interativas (opções clicáveis, como no Claude Code), use-a — melhor UX para o DL e respostas estruturadas. Acompanhe com o texto das perguntas por extenso no chat, para o DL ver o conjunto todo e ficar registrado. Sem a ferramenta, só o texto no chat. Em qualquer caso, escreva cada pergunta na íntegra, numerada, neste formato, e então **pare o turno** (não gere o arquivo ainda, não resuma, não conclua):

```
Terminei o scan. Antes de gerar o relatório final, preciso que você responda a estas perguntas (pode responder pelos números) — elas ajustam alguns scores e o arquivo já sai completo com as respostas:

1. [pergunta fixa de idade, só se não resolvida por LICENSE/CHANGELOG/commit]
2. [pergunta de Fundamentos, por extenso]
3. [pergunta de Harness, por extenso]
...
```

Regras do bloco de perguntas: escreva **todas** (não um subconjunto), **por extenso** (o texto completo, não um rótulo entre parênteses), na ordem idade → Fundamentos → Harness, e **encerre o turno logo após** — a apresentação das perguntas é o fim da sua resposta neste turno, e o arquivo só será gerado no turno seguinte, após a resposta.

Quando a pessoa responder (turno seguinte), **então** gere e salve o relatório no caminho da seção Output, já completo:
- Incorpore as respostas nos scores, na análise e nas recomendações — incluindo reavaliar as travas de Harness (ex: DL confirma autonomia exercida → destrava Fluente se o resto permitir).
- Inclua a seção "## Respostas do DL" com perguntas e respostas registradas.
- Ponha no topo: "✅ Relatório complementado com respostas do DL em [data]".
- Se alguma resposta não vier, gere o arquivo mesmo assim, marcando a pergunta como "sem resposta do DL" na seção — não segure o artefato indefinidamente por uma pendência.

## Contexto para Interpretação (notas fixas do relatório)

- **Suporte de IA por linguagem:** o nível de suporte do stack calibra as expectativas. Stacks de baixo suporte (COBOL, Delphi, .NET legado) têm scores mais baixos esperados — não indica falta de esforço.
- **Ausência de configs no repo:** configs de IA podem viver no nível do usuário (~/.cursor, ~/.claude). Ausência no repo não prova que o time não usa — mas configs no repo são compartilhadas e padronizadas; pessoais não garantem consistência.
- **MCPs:** ausência não é necessariamente gap. MCPs consomem tokens; o que importa é existir onde o projeto se beneficiaria (DB para contexto de schema, GitHub/Jira para tracking).
- **Spec & Planning:** possivelmente a dimensão de maior impacto na qualidade do uso de IA. Sem planejamento antes da execução, o agente opera sem direção e gera retrabalho.
- **Harnessability (Seção 2):** o harness é mais necessário justamente onde é mais difícil de construir. Um time com dívida técnica (testes frágeis, sem tipagem, sem fronteiras de módulo) não tem onde ancorar sensors — o caminho para o harness passa por saldar essa dívida primeiro. Score baixo de Harness com Validação & Qualidade baixa é gap de fundação, não de esforço com IA.

---

Comece a análise agora. Leia a estrutura do repositório, execute o scan das duas seções e, **antes de gerar o arquivo, apresente no chat todas as perguntas complementares por extenso e aguarde a resposta do DL** (as perguntas são um gate — o relatório só é gerado e salvo no turno seguinte, já completo com as respostas). Em execução headless sem chat, gere o arquivo direto com as perguntas em aberto.
