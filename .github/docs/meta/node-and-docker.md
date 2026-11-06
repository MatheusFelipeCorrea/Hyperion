# Node nativo + Docker (parity)

Os scripts Hyperion (`doctor`, `sync`, `upgrade`, `*-verify`…) são o diferencial do kit. Continuam iguais.

| Ambiente | Como rodar |
|----------|------------|
| **Node.js ≥ 20** (preferido) | `npm run hyperion:doctor` ou `node scripts/hyperion/cli.mjs doctor` ou `./bin/hyperion doctor` |
| **Sem Node, com Docker** | `./bin/hyperion doctor` (builda `hyperion-cli` na 1ª vez) |

**English:** [node-and-docker-en.md](./node-and-docker-en.md)

---

## Wrapper

```bash
# Linux / macOS / Git Bash
chmod +x bin/hyperion   # once
./bin/hyperion doctor
./bin/hyperion project-verify
./bin/hyperion upgrade -- --yes
./bin/hyperion cards sync

# Forçar Docker mesmo com Node instalado
./bin/hyperion --docker doctor
# ou: HYPERION_USE_DOCKER=1 ./bin/hyperion doctor
```

Windows (cmd / PowerShell):

```bat
bin\hyperion doctor
bin\hyperion --docker project-verify
```

O wrapper:

1. Se Node ≥ 20 → `node scripts/hyperion/cli.mjs …`
2. Senão (ou `--docker`) → `docker run … hyperion-cli …` com `-v $PWD:/workspace`

A imagem **não** embute o kit: usa os `scripts/` do seu repo (já copiados). Assim o Docker acompanha a versão do kit no cliente.

---

## Build manual da imagem

```bash
npm run hyperion:docker-build
# ou: docker build -t hyperion-cli -f Dockerfile .
```

Variável opcional: `HYPERION_DOCKER_IMAGE=meu-registro/hyperion-cli`.

---

## CLI (`hyperion <cmd>`)

Mesmos comandos que `npm run hyperion:*` (sem o prefixo):

| Comando | Equivalente npm |
|---------|-----------------|
| `hyperion doctor` | `hyperion:doctor` |
| `hyperion sync` | `hyperion:sync` |
| `hyperion upgrade` | `hyperion:upgrade` |
| `hyperion phase-verify` | `hyperion:phase-verify` |
| `hyperion project-verify` | `hyperion:project-verify` |
| `hyperion review-verify` | `hyperion:review-verify` |
| `hyperion cards sync` | `cards:sync` |

`hyperion help` ou `npm run hyperion:help` lista o resto.

---

## O que o chat da IA usa

Skills/agents **não precisam** de Docker: leem Markdown. Quando o agent chama terminal, prefere `npm run hyperion:*` se houver Node; se o usuário só tiver Docker, peça `./bin/hyperion …`.

---

## Ver também

- [definition-of-done.md](./definition-of-done.md) — gates `*-verify`
- [armadilhas-comuns.md](../troubleshooting/armadilhas-comuns.md)
- Repo: [MatheusFelipeCorrea/Hyperion](https://github.com/MatheusFelipeCorrea/Hyperion)
