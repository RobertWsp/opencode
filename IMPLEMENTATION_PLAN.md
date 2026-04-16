# Plano de Implementacao: OpenCode Super-Harness

> **Data**: 2026-04-16 | **Base**: HARNESS_STUDY.md + analise do fork
> **Status**: AGUARDANDO APROVACAO

---

## DIAGNOSTICO DO ESTADO ATUAL

### Saude do Codigo

| Componente | Status | Detalhes |
|-----------|--------|----------|
| Obsidian Memory Plugin | **484 tests, 0 fails** | Solido, production-ready |
| Custom Agents (4) | OK | docs, duplicate-pr, translator, triage |
| Custom Commands (6) | OK | ai-deps, commit, issues, learn, rmslop, spellcheck |
| Custom Tools (2) | OK (desabilitados) | github-pr-search, github-triage |
| Config (opencode.jsonc) | **MINIMAL** | Sem memory, sem MCP, tools desabilitados |

### Arquitetura do Plugin Obsidian-Memory (27 arquivos, 30 test files)

```
PRODUTION-READY:
  ✅ vault.ts + vault-index.ts      — Vault management + indexing
  ✅ scope.ts                        — Git-based scope detection (repo+branch)
  ✅ frontmatter.ts                  — YAML frontmatter parse/serialize
  ✅ injector.ts                     — Memory block injection (3 styles)
  ✅ commands.ts                     — /memory save|list|show|stats|suggested|approve|reject
  ✅ types.ts                        — 11 memory kinds taxonomy
  ✅ parse-entry.ts                  — MemoryEntry enrichment from frontmatter
  ✅ refs.ts                         — File reference verification
  ✅ injection-log.ts                — Audit trail
  ✅ index.ts                        — Plugin entry (605 lines, 6 hooks)

AVANCADOS (testados):
  ✅ capture-gate.ts                 — Haiku-powered auto-capture
  ✅ retrieval.ts                    — BM25 + token jaccard ranking
  ✅ vector-store.ts                 — SQLite-backed vector storage
  ✅ embedder.ts                     — Embedding generation
  ✅ pagerank.ts                     — Graph-aware note ranking
  ✅ consolidator.ts                 — Sonnet-based note consolidation
  ✅ contradiction.ts                — Contradiction detection
  ✅ reflection-scheduler.ts         — Periodic reflection/cleanup
  ✅ session-summary.ts              — Auto session summaries
  ✅ git-event-detector.ts           — Git/GH command enrichment
  ✅ haiku-client.ts                 — Haiku API client
  ✅ candidate-retrieval.ts          — Candidate note selection
  ✅ task-linker.ts                  — Task-to-memory linking
  ✅ auto-init.ts                    — Auto vault initialization
  ✅ vault-git.ts                    — Git operations on vault
```

---

## PLANO EM 6 FRENTES

### FRENTE 1: Obsidian Memory — Polimento e Integracao
**Prioridade**: P0 | **Esforco**: Media | **Impacto**: Alto

#### 1.1 README Atualizado
- [ ] Reescrever README.md refletindo estado real (nao mais "MVP")
- [ ] Documentar TODAS as features atuais (PageRank, vectors, HyDE, etc.)
- [ ] Adicionar secao de config completa com TODAS as opcoes
- [ ] Adicionar diagrama de arquitetura do plugin

#### 1.2 Multi-Provider Injection
- [ ] Remover restricao `providerID !== "anthropic"` no `index.ts:338`
- [ ] Implementar injection para OpenAI/Google/outros (sem cache optimization)
- [ ] Manter cache optimization exclusiva para Anthropic (como esta)
- [ ] Adicionar testes para injection em outros providers

#### 1.3 Config Improvements
- [ ] Adicionar `memory.enabled: true` ao `opencode.jsonc` do projeto
- [ ] Documentar config recomendada para desenvolvimento
- [ ] Criar config template para novos projetos

#### 1.4 Caveat Fixes (do README atual)
- [ ] Fix: branches com slashes colapsam (feature/A = feature-A) — adicionar hash suffix
- [ ] Fix: slash commands still hit LLM — usar router-notifications pattern
- [ ] Fix: "opencode" word rewriting — documentar workaround ou implementar escape

#### 1.5 Memory CLI Enhancement
- [ ] Adicionar `/memory search <query>` — busca full-text nas notas
- [ ] Adicionar `/memory consolidate` — trigger manual de consolidacao
- [ ] Adicionar `/memory health` — status do vault (contagem, tamanho, saude dos refs)
- [ ] Adicionar `/memory export` — exportar notas como JSON para backup

---

### FRENTE 2: Context Engine (inspirado em GSD + Raptor)
**Prioridade**: P0 | **Esforco**: Alta | **Impacto**: Critico

#### 2.1 Fresh Context per Subagent
**Arquivo**: `src/tool/task.ts`

O OpenCode ja cria sessoes separadas por subagent (task.ts:72). O gap e que
nao ha controle de QUANTO contexto cada subagent recebe. Implementar:

- [ ] Adicionar campo `contextBudget` ao Agent.Info schema (agent.ts)
- [ ] Adicionar campo `freshContext: boolean` ao Agent.Info (default: true para subagents)
- [ ] No task.ts, quando `freshContext=true`, NAO carregar historico da sessao pai
- [ ] Quando `freshContext=false` (eg: session continuation via task_id), preservar contexto
- [ ] Config: permitir override por agent no opencode.jsonc

#### 2.2 Progressive Context Loading (Raptor Pattern)
**Arquivo**: `src/session/instruction.ts` + novo `src/session/context-tiers.ts`

- [ ] Definir 3 tiers de contexto:
  - **Tier 1 (Core)**: AGENTS.md + CLAUDE.md + system prompt (sempre carregado)
  - **Tier 2 (Skills)**: Skills relevantes ao contexto atual (carregado sob demanda)
  - **Tier 3 (Memory)**: Obsidian notes relevantes (smart retrieval ja existe)
- [ ] No instruction.ts, implementar loading progressivo por tier
- [ ] Medir tamanho de cada tier e respeitar context budget
- [ ] Config: `contextTiers: { tier1MaxTokens, tier2MaxTokens, tier3MaxTokens }`

#### 2.3 Coverage Tracking (Raptor Pattern)
**Novo arquivo**: `src/session/coverage.ts`

- [ ] Registrar quais arquivos/linhas foram lidos pelo LLM por sessao
- [ ] Hook no ReadTool (read.ts) para tracking automatico
- [ ] Expor via `/memory` ou novo comando `/coverage`
- [ ] Usar coverage data para melhorar retrieval do obsidian-memory
- [ ] Persistir coverage no vault para cross-session learning

---

### FRENTE 3: Skills Enhancement (inspirado em Superpowers)
**Prioridade**: P1 | **Esforco**: Media | **Impacto**: Alto

#### 3.1 Hard Gates
**Novo arquivo**: `src/skill/hardgate.ts`

- [ ] Parser de tags `<HARD-GATE>` em SKILL.md content
- [ ] Injecao de hard gates no system prompt antes da execucao
- [ ] Enforcement: quando hard gate esta ativo, negar tools especificos
- [ ] Exemplo: skill de brainstorming com hard gate contra implementacao prematura
- [ ] Testes para enforcement

#### 3.2 Rationalization Detection
**Novo arquivo**: `src/skill/antipattern.ts`

- [ ] Lista consolidada de anti-patterns (do HARNESS_STUDY.md secao 6.2):
  - "Skip TDD just this once"
  - "This is too simple for design"
  - Scope reduction sem aprovacao
  - Self-certifying
  - Shotgun debugging
  - Type suppression (as any, ts-ignore)
  - Empty catch blocks
  - Deleting failing tests
- [ ] Injecao automatica no system prompt quando skills relevantes estao ativas
- [ ] Formato: `<rationalization-detection>` tag com lista de anti-patterns

#### 3.3 Skill Versioning
**Arquivo**: `src/skill/skill.ts`

- [ ] Adicionar campo `version` ao SKILL.md frontmatter (semver)
- [ ] Adicionar campo `requires` para dependencias entre skills
- [ ] Warning quando skill desatualizada (vs. source URL)
- [ ] Suporte a `skills.urls` com pinning de versao

---

### FRENTE 4: Agent System Enhancement (inspirado em OMO + GSD)
**Prioridade**: P1 | **Esforco**: Alta | **Impacto**: Alto

#### 4.1 Model Tiering
**Novo arquivo**: `src/agent/tiering.ts`

- [ ] Definir 5 tiers: quality, balanced, budget, adaptive, inherit
- [ ] Mapear tiers para modelos concretos por provider:
  ```
  quality:  claude-opus-4-6, gpt-5, gemini-2.5-pro
  balanced: claude-sonnet-4-6, gpt-4.1, gemini-2.5-flash
  budget:   claude-haiku-4-5, gpt-4.1-mini, gemini-2.0-flash-lite
  adaptive: start budget, escalate on complexity
  inherit:  use parent agent's tier
  ```
- [ ] Adicionar campo `tier` ao Agent.Info schema
- [ ] No task.ts, resolver modelo baseado no tier
- [ ] Config: override de tier→modelo no opencode.jsonc

#### 4.2 Intent Gate (OMO pattern — para o harness layer, nao para agents nativos)
**Novo arquivo**: `src/agent/intent.ts`

Nota: Este pattern e implementado atualmente via AGENTS.md do OMO no system prompt.
Para integrar nativamente no OpenCode:

- [ ] Classificador de intent: research/implementation/investigation/evaluation/fix
- [ ] Routing automatico baseado em intent (eg: research → explore agent)
- [ ] Config: `intentGate: { enabled: true, defaultBehavior: "ask" }`
- [ ] Injecao de intent classification hint no system prompt

#### 4.3 Parallel Dispatch Otimizado
**Arquivo**: `src/tool/task.ts`

- [ ] Adicionar campo `maxParallel` ao Agent.Info (default: Infinity)
- [ ] Tracking de subagents ativos por sessao
- [ ] Quando maxParallel atingido, enfileirar tasks
- [ ] Dashboard de status dos subagents (no session metadata)
- [ ] Config: `agent.<name>.maxParallel: N`

---

### FRENTE 5: Workflow Engine (inspirado em GSD + Superpowers)
**Prioridade**: P2 | **Esforco**: Alta | **Impacto**: Medio

#### 5.1 File-Based Planning State
**Novo diretorio**: `src/workflow/`

- [ ] `.opencode/planning/` como diretorio de estado
- [ ] `planning/CONTEXT.md` — locked decisions (D-01, D-02, etc.)
- [ ] `planning/PLAN.md` — plano de execucao atual
- [ ] `planning/STATUS.md` — status de cada task
- [ ] Integracao com plan mode existente (session/prompt.ts)
- [ ] Migrar plan mode para usar `.opencode/planning/` em vez de paths ad-hoc

#### 5.2 Gates Taxonomy
**Novo arquivo**: `src/workflow/gates.ts`

- [ ] 4 tipos de gates: Pre-flight, Revision, Escalation, Abort
- [ ] Pre-flight: verificacoes antes de iniciar task (deps instaladas, tests passam)
- [ ] Revision: verificacao apos completar (lsp diagnostics, tests, build)
- [ ] Escalation: quando task excede complexidade esperada → consultar Oracle
- [ ] Abort: condicoes de parada (3 falhas, budget excedido, circuit breaker)
- [ ] Config: ativar/desativar gates por tipo

#### 5.3 Two-Stage Review
**Novo arquivo**: `src/workflow/review.ts`

- [ ] Stage 1: Spec compliance — o que foi implementado bate com o pedido?
- [ ] Stage 2: Code quality — o codigo segue padroes do projeto?
- [ ] Dispatch automatico de reviewers apos task completion
- [ ] Integracao com requesting-code-review pattern do Superpowers
- [ ] Config: `review.enabled: true, review.autoDispatch: true`

---

### FRENTE 6: Quality & Safety (inspirado em todos)
**Prioridade**: P2 | **Esforco**: Media | **Impacto**: Medio

#### 6.1 Circuit Breaker
**Novo arquivo**: `src/session/circuit-breaker.ts`

- [ ] Detectar sessoes stuck: N tool calls consecutivas sem progresso
- [ ] Metricas de progresso: linhas editadas, tests passando, files criados
- [ ] Quando circuit breaker dispara: pausar, notificar usuario, sugerir proximos passos
- [ ] Config: `circuitBreaker.maxConsecutiveFailures: 5, circuitBreaker.idleTimeoutMs: 300000`

#### 6.2 Budget Enforcement
**Novo arquivo**: `src/session/budget.ts`

- [ ] Tracking de custo por sessao/agent/task (tokens * preco)
- [ ] Limites configuráveis por sessao e por agent
- [ ] Warning quando atingir 80% do budget
- [ ] Hard stop quando atingir 100% (com opcao de override)
- [ ] Dashboard de custos acumulados
- [ ] Config: `budget.sessionMax: "$5", budget.agentMax: "$1"`

#### 6.3 Failure Recovery Protocol
**Arquivo**: `src/tool/task.ts` + `src/session/prompt.ts`

- [ ] Contador de falhas consecutivas por task
- [ ] Apos 3 falhas: STOP → revert changes → document failures
- [ ] Injetar failure context na proxima tentativa
- [ ] Opcao de escalar para Oracle/usuario
- [ ] Config: `recovery.maxRetries: 3, recovery.autoRevert: true`

---

## ORDEM DE EXECUCAO RECOMENDADA

### Sprint 1 (Semana 1-2): Foundation
1. **F1.1** README atualizado
2. **F1.2** Multi-provider injection
3. **F1.3** Config improvements
4. **F2.1** Fresh context per subagent
5. **F3.2** Rationalization detection (baixa complexidade, alto impacto)

### Sprint 2 (Semana 3-4): Intelligence
6. **F2.2** Progressive context loading
7. **F3.1** Hard gates
8. **F4.1** Model tiering
9. **F1.4** Caveat fixes
10. **F1.5** Memory CLI enhancements

### Sprint 3 (Semana 5-6): Orchestration
11. **F4.2** Intent gate
12. **F4.3** Parallel dispatch otimizado
13. **F2.3** Coverage tracking
14. **F3.3** Skill versioning

### Sprint 4 (Semana 7-8): Workflow & Safety
15. **F5.1** File-based planning state
16. **F5.2** Gates taxonomy
17. **F6.1** Circuit breaker
18. **F6.2** Budget enforcement
19. **F6.3** Failure recovery protocol
20. **F5.3** Two-stage review

---

## METRICAS DE SUCESSO

| Metrica | Antes | Meta |
|---------|-------|------|
| Testes passando (obsidian-memory) | 484 | 550+ |
| Providers suportados (injection) | 1 (Anthropic) | 4+ |
| Context rot detection | Nenhum | Fresh context + budget |
| Anti-patterns detectados | 0 | 10+ |
| Model tiers configurados | 1 | 5 |
| Gates de qualidade | 0 | 4 tipos |
| Coverage tracking | Nenhum | Por sessao |
| Cost tracking | Nenhum | Per agent/session |
| Memory CLI commands | 7 | 11+ |

---

## DEPENDENCIAS E RISCOS

| Risco | Mitigacao |
|-------|----------|
| Multi-provider injection quebra cache Anthropic | Manter cache exclusiva para Anthropic, sem cache para outros |
| Fresh context per subagent aumenta custo | Model tiering compensa (budget tier para tasks simples) |
| Hard gates muito restritivos | Config para desabilitar por skill |
| Coverage tracking overhead de performance | Tracking lazy (batch write) + opt-in |
| Circuit breaker false positives | Threshold configuravel + metrics de progresso |

---

## ARQUIVOS NOVOS A CRIAR

```
src/
├── agent/
│   ├── intent.ts          ← F4.2 Intent gate
│   └── tiering.ts         ← F4.1 Model tiering
├── session/
│   ├── budget.ts          ← F6.2 Budget enforcement
│   ├── circuit-breaker.ts ← F6.1 Circuit breaker
│   └── coverage.ts        ← F2.3 Coverage tracking
├── skill/
│   ├── antipattern.ts     ← F3.2 Rationalization detection
│   └── hardgate.ts        ← F3.1 Hard gates
└── workflow/
    ├── gates.ts           ← F5.2 Gates taxonomy
    ├── planning.ts        ← F5.1 File-based planning
    └── review.ts          ← F5.3 Two-stage review
```

## ARQUIVOS EXISTENTES A MODIFICAR

```
src/agent/agent.ts         ← Adicionar contextBudget, freshContext, tier, maxParallel
src/tool/task.ts           ← Fresh context, parallel tracking, failure recovery
src/session/system.ts      ← Anti-patterns injection, intent hints
src/session/instruction.ts ← Progressive loading tiers
src/session/prompt.ts      ← Circuit breaker no loop, gates integration
src/skill/skill.ts         ← Versioning, hard gate parsing
src/plugin/obsidian-memory/
  ├── index.ts             ← Multi-provider injection
  └── README.md            ← Atualizar para estado real
.opencode/opencode.jsonc   ← Config completa
```

---

*Plano gerado em 2026-04-16. Baseado em HARNESS_STUDY.md + diagnostico do fork.*
*Aguardando aprovacao para iniciar implementacao.*
