---
card_id: PROJ-STORY-001
title: "Título curto e claro"
status: Backlog
type: Story
priority: High
sprint: null
story_points: 3
reporter: null
parent: PROJ-FEATURE-001
due_date: null
categories:
  - Backend
---

# [STORY] Título curto e claro

> **Contexto:** Uma frase sobre o valor para o usuário ou o sistema.

## 📝 Descrição

Como **usuário autenticado**, eu quero **ação concreta**, para que **benefício mensurável**.

---

## ✅ Critérios de Aceite

### Cenário 1 — Caminho feliz
**Dado** contexto inicial,  
**Quando** ação do usuário ou chamada `POST /api/exemplo`,  
**Então** resultado esperado (ex.: `201` + payload).

### Cenário 2 — Erro previsível
**Quando** entrada inválida,  
**Então** retorna `400` com mensagem clara.

---

## 🛠️ Implementação

### `src/services/exemplo.service.js` (NOVO — CRIAR)
Criar em: `src/services/exemplo.service.js`  
Seguir padrão de: *(arquivo em `.github/docs/reference/exemplars.md`)*

```javascript
// Assinatura sugerida
export async function criarExemplo(dados) { /* ... */ }
```

### `src/routes/exemplo.routes.js` (EXISTENTE — MODIFICAR)
Métodos existentes (não alterar):
- `listar()` → `GET /api/exemplo`

Métodos **novos**:
- `criar()` → `POST /api/exemplo`

---

## 📐 Regras de Negócio

- Regra 1 com linguagem de negócio
- Regra 2 (validação, limites, permissões)

## 🔗 Sub-issues

- PROJ-TASK-001

## 📋 Resumo

### ✅ Concluído
- Escopo alinhado com o time

### ⏳ Pendente
- Validar contrato da API
- Testes de integração
