# Estudo Comparativo: Harness Systems para AI Coding Agents

> **Data**: 2026-04-16 | **Autor**: Sisyphus (pesquisa automatizada)
> **Objetivo**: Consolidar features e patterns dos principais sistemas para criar um harness super-tool integrado no OpenCode

---

## 1. MAPA DO ECOSSISTEMA

### 1.1 Ranking por Stars

| # | Sistema | Stars | Abordagem | Foco |
|---|---------|-------|-----------|------|
| 1 | **obra/superpowers** | 154,603 | Skills composiveis | Workflow completo (TDD, debug, review) |
| 2 | **affaan-m/everything-claude-code** | ~145,000 | Context + skills + memory | Referencia definitiva para CC |
| 3 | **gsd-build/get-shit-done** | 53,630 | Spec-driven + meta-prompting | Planejamento + execucao com gates |
| 4 | **code-yeongyu/oh-my-openagent** | 51,930 | Multi-agent orchestration | Orquestracao Sisyphus/Oracle/etc |
| 5 | **Yeachan-Heo/oh-my-claudecode** | 29,177 | Teams-first multi-agent | Equipes de agentes coordenados |
| 6 | **alvinunreal/oh-my-opencode-slim** | 3,092 | Token-optimized | Versao enxuta do OMO |
| 7 | **gadievron/raptor** | 1,989 | Security-first agent | Offsec/Defsec com personas |
| 8 | **ntegrals/10x** | 1,344 | Smart model routing | Multi-step com superpowers |
| 9 | **23blocks-OS/ai-maestro** | 608 | Agent orchestrator | Dashboard + agent-to-agent messaging |
| 10 | **Ibrahim-3d/orchestrator-supaconductor** | 333 | Parallel execution | Quality gates + Board of Directors |

### 1.2 Taxonomia de Abordagens

```
HARNESS SYSTEMS
├── SKILLS-BASED (comportamento via documentos)
│   ├── obra/superpowers ─────── 14 skills composiveis, zero-dependency
│   ├── everything-claude-code ─ Skills + memory + context engineering
│   └── raptor ────────────────── 9 security personas + skills progressivas
│
├── SPEC-DRIVEN (planejamento antes de execucao)
│   └── GSD (Get Shit Done) ──── 74 commands, 71 workflows, 31 agents
│
├── ORCHESTRATION-BASED (delegacao a sub-agents)
│   ├── oh-my-openagent ──────── Sisyphus → Oracle/Explore/Librarian
│   ├── oh-my-claudecode ─────── Teams-first coordination
│   └── ai-maestro ───────────── Dashboard + agent messaging
│
└── HYBRID (combinando multiplas abordagens)
    ├── orchestrator-supaconductor ── Superpowers + multi-agent + gates
    ├── template-bridge ───────────── Superpowers + Beads + Templates
    └── silver-bullet ────────────── GSD + Superpowers + Engineering
```

---

## 2. DEEP-DIVE POR SISTEMA

### 2.1 obra/superpowers (154K stars)

**Filosofia**: "Skills are behavior-shaping code, not prose"

**Arquitetura**:
- 14 skills em flat namespace (`skills/<name>/SKILL.md`)
- Formato: YAML frontmatter (name + description) + Markdown corpo
- Zero dependencies externas
- Multi-platform: Claude Code, Cursor, Codex, OpenCode, Copilot, Gemini
- Hook system (SessionStart) para discovery automatico
- Marketplace separada (obra/superpowers-marketplace)

**Skills Catalog**:
| Categoria | Skill | Funcao |
|-----------|-------|--------|
| Testing | test-driven-development | RED-GREEN-REFACTOR enforced |
| Debugging | systematic-debugging | 4-phase root cause analysis |
| Debugging | verification-before-completion | Defense-in-depth antes de entregar |
| Collaboration | brainstorming | Design-first com HARD-GATE |
| Collaboration | writing-plans | Tarefas bite-sized (2-5 min) |
| Collaboration | executing-plans | Execucao de planos |
| Collaboration | subagent-driven-development | Fresh subagent per task + 2-stage review |
| Collaboration | dispatching-parallel-agents | Paralelizacao de trabalho |
| Collaboration | requesting-code-review | Pre-review checklist |
| Collaboration | receiving-code-review | Incorporar feedback |
| Collaboration | using-git-worktrees | Isolamento de workspace |
| Collaboration | finishing-a-development-branch | Merge/PR/cleanup |
| Meta | writing-skills | TDD aplicado a skill creation |
| Meta | using-superpowers | Framework discovery |

**Patterns Unicos**:
1. **Hard Gates**: `<HARD-GATE>` tags que impedem acao prematura
2. **Rationalization Detection**: Documenta desculpas comuns do LLM e bloqueia
3. **TDD para Skills**: RED (agent viola sem skill) → GREEN (skill corrige) → REFACTOR (plug loopholes)
4. **Two-Stage Review**: Spec compliance ANTES de code quality
5. **Model Selection Strategy**: Cheap/Standard/Capable por complexidade da task
6. **94% PR Rejection Rate**: "This PR is slop made of lies"

**Workflow End-to-End**:
```
brainstorming → writing-plans → subagent-driven-development
     │                │                    │
     ▼                ▼                    ▼
 Design doc     Task breakdown      Fresh subagent/task
 User review    Paths + code        Two-stage review
                Verification        TodoWrite tracking
                                         │
                                         ▼
                              requesting-code-review
                                         │
                                         ▼
                          finishing-a-development-branch
```

---

### 2.2 GSD - Get Shit Done (53K stars)

**Filosofia**: "Context rot is the #1 enemy. Fresh agent context per task."

**Arquitetura (4 camadas)**:
```
Layer 1: COMMANDS (74 total)
    └── User-facing slash commands (/gsd research, /gsd plan, etc.)

Layer 2: WORKFLOWS (71 total)
    └── Multi-step sequences triggered by commands

Layer 3: AGENTS (31+ specialized)
    └── Each with fresh 200K token context budget

Layer 4: SDK + FILE SYSTEM
    └── gsd-sdk query + .planning/ directory (Markdown + JSON)
```

**Agentes Especializados (31+)**:
- Researchers (4 paralelos: stack/features/architecture/pitfalls)
- Planner
- Checker/Verifier
- Executor
- 24+ domain-specific agents

**Patterns Unicos**:
1. **Fresh Context per Agent**: Cada agent recebe 200K tokens limpos (resolve context rot)
2. **File-Based State**: `.planning/` com Markdown + JSON (nao database)
3. **Locked Decisions**: CONTEXT.md com decisoes D-01, D-02 que sao non-negotiable
4. **Gates Taxonomy**: Pre-flight, Revision, Escalation, Abort
5. **Model Tiering**: 5 profiles (quality/balanced/budget/adaptive/inherit)
6. **XML + YAML Frontmatter**: Separacao metadata/instructions nos prompts
7. **SDK Query**: `gsd-sdk query` carrega paths, nao artifacts (orchestrators thin)
8. **7 Fases**: Discussion → Research → Planning → Verification → Execution → Verification → UAT

**Diferenciadores vs Competitors**:
| Aspecto | GSD | Superpowers | OMO |
|---------|-----|-------------|-----|
| Context rot | Fresh agent (SOLVED) | Nao trata | Compaction |
| State | File-based (.planning/) | Stateless | DB (SQLite) |
| Agents | 31+ specialized | 0 (skills only) | 7 nativos |
| Orchestration | Serial + Parallel spawn | Manual dispatch | Sisyphus delegates |
| User control | Locked decisions | Hard gates | Todo tracking |

---

### 2.3 oh-my-openagent / Oh-My-OpenCode (52K stars)

**Filosofia**: "Never work alone when specialists are available. Delegate everything."

**Arquitetura**:
- **Sisyphus**: Orchestrador principal (SF Bay Area engineer persona)
- Sub-agents especializados com roles claros
- Background task management com session continuity
- Category-based delegation (visual-engineering, ultrabrain, deep, quick, etc.)
- Skills loading system (project > user > builtin)

**Agentes**:
| Agent | Custo | Funcao |
|-------|-------|--------|
| Sisyphus | - | Orchestrador master |
| Oracle | EXPENSIVE | Consultor read-only, arquitetura, debugging hard |
| Explore | FREE | Contextual grep (codebase) |
| Librarian | CHEAP | Reference grep (docs externos, OSS) |
| Metis | EXPENSIVE | Pre-planning consultant |
| Momus | EXPENSIVE | Plan reviewer |

**Patterns Unicos**:
1. **Intent Gate**: Classifica TODA mensagem antes de agir (Trivial/Explicit/Exploratory/Open-ended/Ambiguous)
2. **Anti-Duplication Rule**: Proibe fazer a mesma busca que delegou ao agent
3. **Delegation Prompt Structure (6 secoes)**: TASK, EXPECTED OUTCOME, REQUIRED TOOLS, MUST DO, MUST NOT DO, CONTEXT
4. **Session Continuity**: Reutiliza session_id para contexto preservado
5. **Oracle Background Policy**: NUNCA entregar resultado sem coletar Oracle
6. **Failure Recovery**: 3 falhas consecutivas → STOP → REVERT → DOCUMENT → CONSULT Oracle
7. **Codebase Assessment**: Disciplined/Transitional/Legacy/Greenfield classification
8. **Evidence Requirements**: File edit → lsp_diagnostics, Build → exit 0, Test → pass

**Phases**:
```
Phase 0: Intent Gate (EVERY message)
    └── Classify → Route → Validate

Phase 1: Codebase Assessment (open-ended tasks)
    └── Config check → Pattern sample → State classify

Phase 2A: Exploration & Research
    └── Explore + Librarian (background, parallel)

Phase 2B: Implementation
    └── Todo tracking → Category delegation → Verification

Phase 2C: Failure Recovery
    └── Root cause → Re-verify → After 3 fails: STOP

Phase 3: Completion
    └── All todos done → Diagnostics clean → Build passes
```

---

### 2.4 Raptor (2K stars)

**Filosofia**: "Adversarial thinking first. Every function is an attack surface."

**Arquitetura**:
```
CLAUDE.md (Bootstrap - sempre carregado)
├── Tier 1: adversarial-thinking, analysis-guidance, recovery
├── Tier 2: 9 Expert Personas
│   ├── Mark Dowd
│   ├── Halvar Flake
│   └── 7 outros especialistas
├── Agents: offsec-specialist (orchestracao autonoma)
└── Alpha: Custom skills do usuario

.claude/
├── skills/SecOpsAgentKit/
├── agents/offsec-specialist.md
├── commands/oss-forensics.md
└── personas/
```

**Patterns Unicos**:
1. **Progressive Loading**: 3 tiers (Bootstrap → Experts → Custom)
2. **9 Expert Personas**: Especialistas de seguranca reais como templates
3. **OSS Forensics Multi-agent**: BigQuery + GitHub Archive + Wayback Machine
4. **Exploit Feasibility Validation**: `exploit_feasibility.py` com constraints reais
5. **Budget Enforcement**: Quota detection + cost management
6. **Coverage Tracking**: Rastreia EXATAMENTE quais arquivos o LLM leu
7. **Dual Interface**: Claude Code (interativo) + Python CLI (scripting)

---

## 3. ANALISE DO OPENCODE FORK (Estado Atual)

### 3.1 Arquitetura Interna

```
src/
├── agent/          ← 7 nativos: build, plan, general, explore, compaction, title, summary
│   ├── agent.ts    ← Agent registry + config merging
│   └── prompt/     ← Prompts por funcao (explore, compaction, summary, title)
├── skill/          ← Discovery de SKILL.md em multiplos locais
│   ├── skill.ts    ← Scan: .claude/skills/, .agents/skills/, .opencode/skill/, URLs
│   └── discovery.ts ← Download skills de URLs remotas
├── tool/           ← 45 tools (read, write, edit, bash, task, todo, etc.)
│   ├── task.ts     ← Subagent launcher com session resumption
│   └── task.txt    ← Task tool description template
├── session/        ← Core loop
│   ├── system.ts   ← System prompts por modelo (anthropic, beast, gemini, codex, trinity)
│   ├── instruction.ts ← Carrega AGENTS.md + CLAUDE.md (project + global)
│   ├── prompt.ts   ← Main loop: message → tools → compaction → structured output
│   └── compaction.ts ← Context overflow management
├── plugin/         ← Hook-based (auth, tool interception, message transform)
│   ├── anthropic.ts
│   ├── codex.ts
│   └── copilot.ts
├── command/        ← Slash commands
├── config/         ← Config loading
├── mcp/            ← MCP server integration
└── provider/       ← Multi-provider (20+ AI SDKs)
```

### 3.2 Pontos Fortes Atuais

1. **Multi-provider nativo**: 20+ provedores de IA (Anthropic, OpenAI, Google, etc.)
2. **Skill discovery robusto**: Scan em 5+ locais diferentes
3. **Task tool com session resumption**: Subagents podem ser continuados
4. **Plugin system extensivel**: Hooks para auth, tool interception, message transform
5. **System prompts por modelo**: Otimizado para cada familia de modelo
6. **Instruction hierarchy**: Project AGENTS.md > Global AGENTS.md > Global CLAUDE.md
7. **Compaction automatica**: Gerencia context overflow
8. **Plan mode**: Modo read-only com plan file persistente

### 3.3 Gaps Identificados (vs. Competitors)

| Gap | Quem Resolve | Prioridade |
|-----|-------------|------------|
| **Sem context rot solution** | GSD (fresh context/agent) | CRITICA |
| **Sem hard gates** | Superpowers (HARD-GATE tags) | ALTA |
| **Sem rationalization detection** | Superpowers (anti-patterns documentados) | ALTA |
| **Sem model tiering** | GSD (5 profiles), Superpowers (cheap/standard/capable) | ALTA |
| **Sem gates taxonomy** | GSD (Pre-flight, Revision, Escalation, Abort) | MEDIA |
| **Sem progressive loading** | Raptor (3 tiers de contexto) | MEDIA |
| **Sem expert personas** | Raptor (9 personas especializadas) | MEDIA |
| **Sem file-based state** | GSD (.planning/ com locked decisions) | MEDIA |
| **Sem coverage tracking** | Raptor (quais arquivos o LLM leu) | MEDIA |
| **Sem exploit/validation loop** | Raptor (external validation) | BAIXA |
| **Sem parallel dispatch otimizado** | GSD (4 researchers simultaneos) | MEDIA |
| **Sem two-stage review** | Superpowers (spec → quality) | MEDIA |
| **Sem marketplace nativo** | Superpowers (plugin marketplace) | BAIXA |
| **Sem circuit breaker** | OpenHarness (detect stuck sessions) | MEDIA |
| **Sem budget enforcement** | Raptor (quota detection) | BAIXA |

---

## 4. MATRIZ COMPARATIVA COMPLETA

### 4.1 Features por Sistema

| Feature | OpenCode | Superpowers | GSD | OMO | Raptor |
|---------|----------|-------------|-----|-----|--------|
| Skills composiveis | Parcial | ★★★ | ★★ | ★★ | ★★ |
| Multi-agent orchestration | Basico | ✗ | ★★★ | ★★★ | ★★ |
| TDD enforcement | ✗ | ★★★ | ★★ | ★ | ✗ |
| Context rot solution | Compaction | ✗ | ★★★ | Compaction | ✗ |
| File-based planning | Plan mode | ✗ | ★★★ | ✗ | ✗ |
| Hard gates | ✗ | ★★★ | ★★ | ✗ | ✗ |
| Model tiering | ✗ | ★★ | ★★★ | ★ | ✗ |
| Parallel dispatch | Basico | ★★ | ★★★ | ★★★ | ✗ |
| Session continuity | ★★★ | ✗ | ✗ | ★★★ | ✗ |
| Plugin ecosystem | ★★★ | ★★★ | ★ | ★★ | ★ |
| Multi-platform | ★★ | ★★★ | ★★★ | ★ | ★ |
| Personas/roles | ✗ | ✗ | ★★ | ★★ | ★★★ |
| Budget/cost management | ✗ | ✗ | ✗ | ✗ | ★★★ |
| Coverage tracking | ✗ | ✗ | ★★ | ✗ | ★★★ |
| Rationalization detection | ✗ | ★★★ | ✗ | ✗ | ✗ |
| External validation | ✗ | ★★ | ★★ | ★★ | ★★★ |
| Locked decisions | ✗ | ✗ | ★★★ | ✗ | ✗ |

### 4.2 Abordagem de Prompt Engineering

| Aspecto | Superpowers | GSD | OMO | Raptor |
|---------|-------------|-----|-----|--------|
| **Formato** | Markdown + YAML frontmatter | XML + YAML frontmatter | Markdown structurado | Markdown + personas |
| **Tags** | `<HARD-GATE>` | `<role>`, `<context_fidelity>`, `<scope_reduction_prohibition>` | `<intent_verbalization>`, `<Anti_Duplication>` | `<tier>`, `<persona>` |
| **Injeccao** | SKILL.md discovery | Commands + workflows | AGENTS.md system prompt | CLAUDE.md progressive |
| **Anti-patterns** | Rationalization lists | Deferred ideas prohibition | Delegation duplication | Budget overflow |
| **Enforcement** | Hard gates | Locked decisions + gates | Todo tracking + evidence | Exploit validation |

---

## 5. RECOMENDACOES PARA O SUPER-TOOL

### 5.1 Arquitetura Proposta (Consolidacao)

```
OPENCODE SUPER-HARNESS
│
├── LAYER 1: CONTEXT ENGINE (inspirado em GSD + Raptor)
│   ├── Fresh context per subagent (GSD pattern)
│   ├── Progressive loading (Raptor: 3 tiers)
│   ├── Coverage tracking (Raptor: quais arquivos foram lidos)
│   ├── Context budget management (200K tokens/agent)
│   └── Automatic compaction (OpenCode existente)
│
├── LAYER 2: SKILLS FRAMEWORK (inspirado em Superpowers)
│   ├── SKILL.md format (YAML frontmatter + Markdown)
│   ├── Hard gates (<HARD-GATE> tags)
│   ├── Rationalization detection (anti-patterns documentados)
│   ├── TDD para skills (RED-GREEN-REFACTOR)
│   ├── Multi-platform skill discovery (existente + marketplace)
│   └── Skill versioning + dependency resolution
│
├── LAYER 3: AGENT ORCHESTRATION (inspirado em OMO + GSD)
│   ├── Intent gate (OMO: classifica toda mensagem)
│   ├── Category-based delegation (OMO: visual, ultrabrain, deep, quick)
│   ├── Agent specialization (GSD: 31+ domain agents)
│   ├── Session continuity (OpenCode existente + OMO enhancement)
│   ├── Model tiering (GSD: quality/balanced/budget/adaptive)
│   ├── Parallel dispatch otimizado (GSD: 4 researchers)
│   └── Oracle consultation pattern (OMO)
│
├── LAYER 4: WORKFLOW ENGINE (inspirado em GSD + Superpowers)
│   ├── Spec-driven development (GSD: 7 fases)
│   ├── File-based state (.planning/ com locked decisions)
│   ├── Gates taxonomy (Pre-flight, Revision, Escalation, Abort)
│   ├── Two-stage review (Superpowers: spec → quality)
│   ├── Subagent-driven development (Superpowers pattern)
│   └── Brainstorming → Planning → Implementation → Review → Merge
│
├── LAYER 5: QUALITY & SAFETY (inspirado em todos)
│   ├── Evidence requirements (OMO: diagnostics, build, test)
│   ├── Failure recovery protocol (OMO: 3 fails → STOP → REVERT)
│   ├── Circuit breaker (OpenHarness: detect stuck sessions)
│   ├── External validation loop (Raptor: never self-certify)
│   ├── Budget enforcement (Raptor: quota + cost tracking)
│   └── Coverage tracking (Raptor: what was read)
│
└── LAYER 6: OBSERVABILITY & MEMORY
    ├── Session memory (cross-session context)
    ├── Triple-layer memory (OpenHarness: pointer/knowledge/stream)
    ├── Cost tracking per agent/task
    ├── Performance metrics (tokens, time, success rate)
    └── Audit trail (decisions, delegations, outcomes)
```

### 5.2 Features Prioritarias para Implementacao

#### P0 - Criticas (impacto imediato na qualidade)

| Feature | Inspiracao | Complexidade | Impacto |
|---------|-----------|--------------|---------|
| **Fresh context per subagent** | GSD | Media | Elimina context rot |
| **Hard gates no prompt system** | Superpowers | Baixa | Previne acoes prematuras |
| **Model tiering** | GSD | Media | Otimiza custo/qualidade |
| **Rationalization detection** | Superpowers | Baixa | Previne shortcuts do LLM |

#### P1 - Altas (melhoram workflow significativamente)

| Feature | Inspiracao | Complexidade | Impacto |
|---------|-----------|--------------|---------|
| **Gates taxonomy** | GSD | Media | Controle de qualidade |
| **Two-stage review** | Superpowers | Media | Review mais eficaz |
| **File-based planning state** | GSD | Media | Persistencia de decisoes |
| **Progressive context loading** | Raptor | Media | Otimiza uso de tokens |
| **Coverage tracking** | Raptor | Alta | Sabe o que o LLM leu |
| **Parallel dispatch otimizado** | GSD | Media | Throughput de pesquisa |

#### P2 - Medias (melhoram DX e observabilidade)

| Feature | Inspiracao | Complexidade | Impacto |
|---------|-----------|--------------|---------|
| **Circuit breaker** | OpenHarness | Media | Previne loops infinitos |
| **Budget enforcement** | Raptor | Media | Controle de custos |
| **Expert personas** | Raptor | Baixa | Especializacao por dominio |
| **Locked decisions** | GSD | Baixa | Previne re-debate |
| **Skill marketplace** | Superpowers | Alta | Ecossistema extensivel |
| **Triple-layer memory** | OpenHarness | Alta | Memoria cross-session |

### 5.3 Implementacao Sugerida por Camada

#### Camada 1: Context Engine (Semana 1-2)

**O que implementar:**
- Configuracao de `context_budget` por agent no `agent.ts`
- Flag para "fresh context" vs "shared context" por subagent type
- Mecanismo de progressive loading: Core → Skills → Domain → Custom
- Coverage tracker: registrar quais arquivos/linhas foram lidos por sessao

**Onde no codigo:**
- `src/agent/agent.ts` - adicionar campos `contextBudget`, `freshContext`, `loadingTier`
- `src/session/prompt.ts` - implementar context budget enforcement
- `src/tool/read.ts` - adicionar tracking de arquivos lidos
- Novo: `src/session/coverage.ts` - coverage tracker

#### Camada 2: Skills Enhancement (Semana 2-3)

**O que implementar:**
- Hard gate parser: detectar `<HARD-GATE>` tags em SKILL.md e enforcar
- Rationalization detection: lista de anti-patterns injetada no system prompt
- TDD skill template: scaffolding para criar skills com testes
- Skill versioning: semver no frontmatter

**Onde no codigo:**
- `src/skill/skill.ts` - parser de hard gates e anti-patterns
- `src/session/system.ts` - injetar anti-patterns no system prompt
- Novo: `src/skill/hardgate.ts` - hard gate enforcement
- Novo: `src/skill/antipattern.ts` - rationalization detection

#### Camada 3: Agent Orchestration (Semana 3-4)

**O que implementar:**
- Model tiering: 5 profiles configuravel por agent
- Agent specialization: config para criar agents domain-specific
- Parallel dispatch com tracking (max N simultaneos, status dashboard)
- Intent gate automatico antes de cada mensagem

**Onde no codigo:**
- `src/agent/agent.ts` - adicionar `modelTier`, `maxParallel`
- `src/tool/task.ts` - parallel tracking + model tier selection
- Novo: `src/agent/intent.ts` - intent classification
- Novo: `src/agent/tiering.ts` - model selection strategy

#### Camada 4: Workflow Engine (Semana 4-6)

**O que implementar:**
- File-based planning state (`.opencode/planning/`)
- Locked decisions tracking (D-01, D-02, etc.)
- Gates taxonomy (pre-flight, revision, escalation, abort)
- Two-stage review (spec compliance → code quality)

**Onde no codigo:**
- Expandir `src/session/prompt.ts` plan mode
- Novo: `src/workflow/planning.ts` - file-based state
- Novo: `src/workflow/gates.ts` - gates taxonomy
- Novo: `src/workflow/review.ts` - two-stage review

#### Camada 5: Quality & Safety (Semana 6-8)

**O que implementar:**
- Circuit breaker: detectar sessoes stuck (N tool calls sem progresso)
- Budget enforcement: limites de custo por sessao/agent
- External validation: hook para validacao independente
- Failure recovery: protocol de 3 falhas

**Onde no codigo:**
- `src/session/prompt.ts` - circuit breaker no loop
- Novo: `src/session/budget.ts` - cost tracking + enforcement
- Novo: `src/session/circuit-breaker.ts` - stuck detection
- `src/tool/task.ts` - failure recovery protocol

---

## 6. PATTERNS DE PROMPT ENGINEERING CONSOLIDADOS

### 6.1 Tags XML Recomendadas (Best-of-All)

De **Superpowers**:
```xml
<HARD-GATE>
Acao X esta PROIBIDA ate condicao Y ser satisfeita.
</HARD-GATE>
```

De **GSD**:
```xml
<role>Agent especializado em X</role>
<context_fidelity>HIGH - use ONLY provided context, NO assumptions</context_fidelity>
<scope_reduction_prohibition>NEVER reduce scope without explicit approval</scope_reduction_prohibition>
```

De **OMO**:
```xml
<intent_verbalization>
Antes de agir, verbalize: "Detecto intent de [tipo] - [razao]. Minha abordagem: [routing]."
</intent_verbalization>

<Anti_Duplication>
Uma vez delegado, NAO repetir a mesma busca.
</Anti_Duplication>
```

De **Raptor**:
```xml
<tier level="1">Carregamento progressivo - apenas contexto essencial</tier>
<persona name="Expert">Raciocinio from perspective de [especialista]</persona>
```

### 6.2 Anti-Patterns Universais (Consolidacao)

| Anti-Pattern | Fonte | Deteccao |
|-------------|-------|----------|
| "Skip TDD just this once" | Superpowers | Rationalization list |
| "This is too simple for design" | Superpowers | Hard gate |
| Scope reduction sem aprovacao | GSD | Locked decisions |
| Self-certifying (auto-validacao) | Raptor | External validation |
| Delegation duplication | OMO | Anti-duplication rule |
| Shotgun debugging (random changes) | OMO | Failure protocol |
| Context rot (conversa longa) | GSD | Fresh context/agent |
| Type suppression (as any, ts-ignore) | OMO | Evidence requirements |
| Empty catch blocks | OMO | Evidence requirements |
| Deleting failing tests | OMO | Evidence requirements |

### 6.3 Model Tiering Strategy (GSD + Superpowers)

```
QUALITY (most expensive):
  - Architecture decisions
  - Complex multi-file coordination
  - Security-sensitive code
  - Design/brainstorming

BALANCED (default):
  - Feature implementation
  - Multi-file changes
  - Code review

BUDGET (cheapest):
  - Isolated functions with clear specs
  - Single-file changes
  - Grep/search tasks
  - Test-only changes

ADAPTIVE (auto-select):
  - Start budget, escalate if complexity detected

INHERIT (from parent):
  - Subagent herda tier do parent agent
```

---

## 7. CONCLUSAO

### 7.1 Insight Principal

**Nenhum sistema tem TUDO.** A oportunidade esta na CONSOLIDACAO:

- **Superpowers** resolve behavior shaping mas NAO orquestra
- **GSD** resolve context rot e planning mas NAO tem skills composiveis
- **OMO** resolve orchestration mas NAO tem hard gates ou model tiering
- **Raptor** resolve progressive loading e validation mas E domain-specific

### 7.2 O OpenCode Como Base Ideal

O OpenCode ja tem:
- Multi-provider nativo (20+ SDKs)
- Plugin system extensivel
- Skill discovery robusto
- Session continuity
- Task tool com subagents

Falta adicionar:
- Context engine (GSD patterns)
- Behavior shaping (Superpowers patterns)
- Quality gates (GSD + Superpowers + Raptor patterns)
- Observability (cost/coverage/memory)

### 7.3 Visao Final

```
OPENCODE SUPER-HARNESS = 
    OpenCode (base, multi-provider, plugins, sessions)
  + Superpowers (skills, hard gates, TDD, rationalization detection)
  + GSD (fresh context, file planning, locked decisions, model tiering)
  + OMO (orchestration, intent gate, delegation protocol)
  + Raptor (progressive loading, coverage, validation, personas)
```

**Resultado**: Um harness completamente ageNtico que combina o melhor de 5 sistemas
em uma plataforma integrada, extensivel e multi-provider.

---

## APENDICE A: Repositorios Estudados

| Repo | URL | Stars |
|------|-----|-------|
| obra/superpowers | https://github.com/obra/superpowers | 154,603 |
| gsd-build/get-shit-done | https://github.com/gsd-build/get-shit-done | 53,630 |
| code-yeongyu/oh-my-openagent | https://github.com/code-yeongyu/oh-my-openagent | 51,930 |
| Yeachan-Heo/oh-my-claudecode | https://github.com/Yeachan-Heo/oh-my-claudecode | 29,177 |
| gadievron/raptor | https://github.com/gadievron/raptor | 1,989 |
| ntegrals/10x | https://github.com/ntegrals/10x | 1,344 |
| affaan-m/everything-claude-code | https://github.com/affaan-m/everything-claude-code | ~145,000 |
| evoerax/awesome-harness-engineering | https://github.com/evoerax/awesome-harness-engineering | - |
| alvinunreal/oh-my-opencode-slim | https://github.com/alvinunreal/oh-my-opencode-slim | 3,092 |
| Ibrahim-3d/orchestrator-supaconductor | https://github.com/Ibrahim-3d/orchestrator-supaconductor | 333 |

## APENDICE B: Fontes Secundarias

| Repo | Contribuicao |
|------|-------------|
| obra/superpowers-marketplace | Marketplace de plugins |
| obra/superpowers-lab | Skills experimentais |
| obra/superpowers-chrome | Browser control |
| OpenCode (fork local) | Base de implementacao |

---

*Estudo gerado por pesquisa automatizada em 2026-04-16. 6 agentes librarian + analise direta do fork local.*
