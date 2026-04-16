# Análise Profunda: Refinamento do OpenCode Super-Harness

> **Data**: 2026-04-16 | **Base**: Deep-dives em obra/superpowers, GSD, everything-claude-code, oh-my-openagent
> **Objetivo**: Identificar gaps e refinamentos para tornar o harness completamente agêntico

---

## 1. PADRÕES CRÍTICOS EXTRAÍDOS (Código Real)

### 1.1 Superpowers: Hard Gates São Imperativos, Não Sugestões

**O que encontramos no código real:**

```xml
<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project,
or take any implementation action until you have presented a design
and the user has approved it. This applies to EVERY project regardless
of perceived simplicity.
</HARD-GATE>
```

**Nosso gap**: Nosso `hardgate.ts` parseia `<HARD-GATE>` tags mas NÃO ENFORÇA — apenas formata para injection no system prompt. O superpowers usa o gate como **bloqueio imperativo** que o LLM respeita por peso semântico.

**Refinamento necessário**:
- Hard gates precisam de `blocked: tool1, tool2` que REALMENTE deny permissions via `PermissionNext`
- Não basta injetar texto — precisa integrar com o permission system do agent

---

### 1.2 Superpowers: Rationalization Tables com Matching Exato

**Código real (test-driven-development/SKILL.md):**

```markdown
| Excuse                                 | Reality                                    |
| -------------------------------------- | ------------------------------------------ |
| "Too simple to test"                   | Simple code breaks. Test takes 30 seconds. |
| "I'll test after"                      | Tests passing immediately prove nothing.   |
| "Already manually tested"              | Ad-hoc ≠ systematic. No record.            |
| "TDD will slow me down"               | TDD faster than debugging.                 |
| "Existing code has no tests"           | You're improving it. Add tests.            |
```

**Nosso gap**: Nosso `antipattern.ts` tem 10 entries estáticos. O Superpowers tem **tabelas por skill** com 11+ entries específicas ao contexto.

**Refinamento necessário**:
- Anti-patterns devem ser **contextuais por skill**, não globais
- `fromSkill()` já extrai de `<rationalization>` tags — precisa popular skills reais com essas tabelas

---

### 1.3 Superpowers: Red Flags = Parada Binária

**Código real:**

```markdown
## Red Flags - STOP and Start Over

- Code before test
- Test after implementation
- Test passes immediately
- Can't explain why test failed
- Rationalizing "just this once"
- "It's about spirit not ritual"
- "Already spent X hours, deleting is wasteful"
- "This is different because..."

**All of these mean: Delete code. Start over with TDD.**
```

**Nosso gap**: Não temos conceito de "red flag" — nosso circuit breaker é baseado em métricas (calls, edits), não em **detecção semântica de comportamento**.

**Refinamento necessário**:
- Adicionar `RedFlag` type ao `antipattern.ts` com severidade "stop"
- Quando detectado, o sistema deve PARAR e pedir reconfirmação

---

### 1.4 GSD: 3-Layer Architecture (Orchestrator → Agent → SDK)

**Código real do gsd-planner.md:**

```markdown
<role>
You are a GSD planner. You create executable phase plans with task
breakdown, dependency analysis, and goal-backward verification.
</role>

<context_fidelity>
## CRITICAL: User Decision Fidelity

Before creating ANY task, verify:
1. Locked Decisions (from ## Decisions) — MUST be implemented exactly
2. Deferred Ideas (from ## Deferred Ideas) — MUST NOT appear in plans
3. Claude's Discretion (from ## Claude's Discretion) — Use judgment
</context_fidelity>
```

**Nosso gap**: Nosso `planning.ts` tem CONTEXT.md com decisions, mas NÃO tem:
- Context fidelity check (verificar que decisions locked são respeitadas)
- Deferred ideas tracking (coisas que NÃO devem aparecer)
- Discovery levels (0-skip, 1-quick, 2-standard)

**Refinamento necessário**:
- Adicionar `deferred` field ao `Decision` type em `planning.ts`
- Adicionar `discretion` field para items a critério do agent
- Implementar verificação de fidelity no prompt loop

---

### 1.5 GSD: Deviation Rules (Auto-fix vs Ask)

**Código real do gsd-executor.md:**

```markdown
<deviation_rules>
RULE 1: Auto-fix bugs (broken behavior, errors) → Fix inline, no permission
RULE 2: Auto-add missing critical functionality → Fix inline, no permission
RULE 3: Auto-fix blocking issues (deps, types, imports) → Fix inline, no permission
RULE 4: Ask about architectural changes → STOP, return checkpoint

RULE PRIORITY:
1. Rule 4 applies → STOP (architectural decision)
2. Rules 1-3 apply → Fix automatically
3. Genuinely unsure → Rule 4 (ask)
</deviation_rules>
```

**Nosso gap**: Nosso failure recovery é simples (3-strike + stop). GSD tem **regras de desvio categorizadas** que permitem auto-fix para 3 categorias mas PARAM para mudanças arquiteturais.

**Refinamento necessário**:
- Implementar deviation rules no task executor
- Categorizar desvios em: auto-fix (Rules 1-3) vs ask (Rule 4)
- Integrar com o circuit breaker existente

---

### 1.6 GSD: SDK Query Registry

**Código real:**

```bash
INIT=$(gsd-sdk query init.execute-phase "${PHASE}")
EXECUTOR_MODEL=$(gsd-sdk query config-get workflow.executor_model)
TDD_MODE=$(gsd-sdk query config-get workflow.tdd_mode)
gsd-sdk query commit "feat: add email flow" "src/email.ts"
```

**Nosso gap**: Estado do workflow é espalhado — não temos um **registry centralizado** de queries tipadas para state management.

**Refinamento necessário**:
- Adicionar query functions ao `planning.ts` (config-get, state, phases.list)
- Usar pattern de SDK para orquestração thin (orchestrator pede paths, não dados)

---

### 1.7 ECC: Hook Recipes de Produção

**Código real de hooks:**

```json
// Block large files (>800 linhas)
{
  "matcher": "Write",
  "hooks": [{
    "type": "command",
    "command": "node -e \"...if(lines>800){console.error('BLOCKED');process.exit(2)}...\""
  }]
}

// Auto-format Python
{
  "matcher": "Edit",
  "hooks": [{
    "type": "command",
    "command": "node -e \"...if(/\\.py$/.test(p)){execFileSync('ruff',['format',p])}...\""
  }]
}

// Require test file alongside source
{
  "matcher": "Write",
  "hooks": [{
    "type": "command",
    "command": "node -e \"...if(!fs.existsSync(testPath)){console.error('No test file')}...\""
  }]
}
```

**Nosso gap**: Não temos hooks pre-built. O plugin system do OpenCode suporta hooks mas falta um **catálogo de recipes**.

**Refinamento necessário**:
- Criar catálogo de hook recipes em `.opencode/hooks/`
- Integrar hook recipes mais comuns como defaults configuráveis

---

### 1.8 ECC: Continuous Learning (Instinct System)

**Padrão:**

```
Session → Observe patterns → Extract instincts → Save com confidence score
→ /evolve clusters into skills → Skills carregadas automaticamente
```

**Nosso gap**: Temos obsidian-memory para persistência, mas NÃO temos:
- Extração automática de padrões (instincts)
- Clustering de instincts em skills
- Confidence scoring

**Refinamento necessário**:
- Integrar instinct extraction no session-summary do obsidian-memory
- Adicionar confidence scoring às notas de memória

---

### 1.9 ECC: Security Minimum Bar

**Checklist crítico:**

```
□ Separate agent identities from personal accounts
□ Use short-lived scoped credentials
□ Run untrusted work in containers/VMs
□ Deny outbound network by default
□ Restrict reads from secret-bearing paths
□ Sanitize files before LLM sees them
□ Require approval for unsandboxed shell/egress
□ Log tool calls, approvals, network attempts
□ Implement process-group kill + heartbeat
□ Keep persistent memory narrow & disposable
```

**Nosso gap**: Nosso budget.ts rastreia custos mas NÃO temos:
- Kill switches (heartbeat dead-man)
- Network egress restrictions
- Secret path protection
- Tool call logging/audit

**Refinamento necessário**:
- Adicionar audit trail ao budget.ts (log tool calls)
- Integrar secret path protection nas permissions do agent

---

### 1.10 Superpowers: Skill Encadeamento Automático

**Fluxo real:**

```
brainstorming → writing-plans → subagent-driven-development → finishing-branch
     │               │                    │                        │
     ▼               ▼                    ▼                        ▼
 Design doc     Task breakdown    Fresh subagent/task         Merge/PR
 User review    2-5 min steps     Two-stage review           Cleanup
```

**Nosso gap**: Skills são independentes — não há **encadeamento automático** de um skill para o próximo.

**Refinamento necessário**:
- Adicionar campo `next` ao SKILL.md frontmatter (skill seguinte no workflow)
- Adicionar campo `requires` (skill que deve ter sido executado antes)
- O system prompt deve sugerir o próximo skill automaticamente

---

## 2. GAPS CRÍTICOS DO NOSSO FORK (Priorizado)

### Tier S (Game-changers — impacto máximo)

| # | Gap | De onde vem | Complexidade | Impacto |
|---|-----|-------------|--------------|---------|
| 1 | **Hard gates NÃO enforcam permissions** | Superpowers | Média | Crítico |
| 2 | **Sem deviation rules categorizadas** | GSD | Média | Crítico |
| 3 | **Sem verificação de decision fidelity** | GSD | Média | Alto |
| 4 | **Sem two-stage review real** | Superpowers | Alta | Alto |
| 5 | **Granularidade de tasks é vaga** | Superpowers | Baixa | Alto |

### Tier A (Melhorias significativas)

| # | Gap | De onde vem | Complexidade | Impacto |
|---|-----|-------------|--------------|---------|
| 6 | **Anti-patterns não são contextuais por skill** | Superpowers | Baixa | Médio |
| 7 | **Sem red flags com parada binária** | Superpowers | Baixa | Médio |
| 8 | **Sem skill encadeamento automático** | Superpowers | Média | Médio |
| 9 | **Sem discovery levels (0-2)** | GSD | Baixa | Médio |
| 10 | **Sem deferred ideas tracking** | GSD | Baixa | Médio |

### Tier B (Nice-to-have)

| # | Gap | De onde vem | Complexidade | Impacto |
|---|-----|-------------|--------------|---------|
| 11 | **Sem hook recipes catálogo** | ECC | Média | Médio |
| 12 | **Sem instinct extraction** | ECC | Alta | Médio |
| 13 | **Sem audit trail de tool calls** | ECC | Média | Médio |
| 14 | **Sem kill switch / heartbeat** | ECC | Média | Baixo |
| 15 | **Sem secret path protection** | ECC | Baixa | Médio |

---

## 3. REFINAMENTOS PRIORIZADOS (Implementação)

### Sprint 1: Hard Gate Enforcement + Deviation Rules

#### R1. Hard Gate Permission Integration

**Arquivo**: `src/skill/hardgate.ts` + `src/session/prompt.ts`

**O que mudar**:
```typescript
// hardgate.ts - adicionar enforcement via permissions
export function enforce(gates: Gate[], agent: Agent.Info): PermissionNext.Ruleset {
  const rules: PermissionNext.Ruleset = []
  for (const gate of gates) {
    for (const tool of gate.blocked) {
      rules.push({
        permission: tool,
        pattern: "*",
        action: "deny",
      })
    }
  }
  return rules
}

// prompt.ts - aplicar gates antes de resolver tools
const skills = await Skill.all()
const gates = skills.flatMap(s => HardGate.parse(s.content))
const gateRules = HardGate.enforce(gates, agent)
// Merge gate rules into agent permissions for this turn
```

#### R2. Deviation Rules no Task Executor

**Arquivo**: `src/tool/task.ts`

**O que adicionar**:
```typescript
// Deviation categories
const DEVIATION = {
  BUG: "auto",        // Rule 1: auto-fix bugs
  MISSING: "auto",    // Rule 2: auto-add missing critical
  BLOCKING: "auto",   // Rule 3: auto-fix blocking issues
  ARCH: "ask",        // Rule 4: ask about architectural changes
} as const

// Inject deviation rules into subagent prompt
const deviationPrompt = `
<deviation_rules>
While executing, apply these rules automatically:
- Bugs (broken behavior, errors): Fix inline, no permission needed
- Missing critical functionality (auth, validation): Add inline
- Blocking issues (deps, types, imports): Fix inline
- Architectural changes (new DB table, schema, service layer): STOP and ask
</deviation_rules>
`
```

#### R3. Decision Fidelity Check

**Arquivo**: `src/workflow/planning.ts`

**O que adicionar**:
```typescript
// Decision types
export type DecisionKind = "locked" | "deferred" | "discretion"

export const Decision = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  locked: z.boolean(),
  kind: z.enum(["locked", "deferred", "discretion"]).default("locked"),
})

// Fidelity check prompt injection
export function fidelityPrompt(decisions: Decision[]): string {
  const locked = decisions.filter(d => d.kind === "locked")
  const deferred = decisions.filter(d => d.kind === "deferred")
  
  return `<context_fidelity>
Before creating ANY task, verify:
1. Locked Decisions — MUST be implemented exactly:
${locked.map(d => `   ${d.id}: ${d.title}`).join("\n")}

2. Deferred Ideas — MUST NOT appear:
${deferred.map(d => `   ${d.id}: ${d.title}`).join("\n")}

3. Discretion — Use your judgment
</context_fidelity>`
}
```

---

### Sprint 2: Task Granularity + Red Flags

#### R4. Task Granularity Template (Superpowers Pattern)

**Nova seção no system prompt quando planning mode ativo:**

```markdown
## Task Structure (2-5 minutes each)

Each task MUST contain:
- [ ] Step 1: Write the failing test (actual code)
- [ ] Step 2: Run test to verify it fails (exact command + expected output)
- [ ] Step 3: Write minimal implementation (actual code)
- [ ] Step 4: Run test to verify it passes (exact command)
- [ ] Step 5: Commit (exact git command)

## No Placeholders Allowed
- "TBD", "TODO", "implement later" = PLAN FAILURE
- "Add appropriate error handling" = PLAN FAILURE
- "Similar to Task N" = PLAN FAILURE (repeat the code)
- Steps without code blocks = PLAN FAILURE
```

#### R5. Red Flag Detection

**Arquivo**: `src/skill/antipattern.ts`

**Adicionar ao namespace:**
```typescript
export const REDFLAGS: Entry[] = [
  { pattern: "Code before test", response: "Delete code. Start over with TDD.", severity: "block" },
  { pattern: "Test passes immediately", response: "Test proves nothing. Rewrite to fail first.", severity: "block" },
  { pattern: "Can't explain why test failed", response: "Understanding > doing. Investigate first.", severity: "block" },
  { pattern: "just this once", response: "No exceptions. Follow the process.", severity: "block" },
  { pattern: "This is different because", response: "It's not. Apply the same rigor.", severity: "block" },
  { pattern: "Already spent X hours", response: "Sunk cost fallacy. Delete and restart.", severity: "block" },
]
```

---

### Sprint 3: Skill Encadeamento + Two-Stage Review

#### R6. Skill Workflow Chaining

**Arquivo**: `src/skill/skill.ts`

**Adicionar ao frontmatter:**
```yaml
---
name: brainstorming
description: Design-first approach
next: writing-plans
requires: []
---
```

**Parser:**
```typescript
export const Info = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  content: z.string(),
  next: z.string().optional(),     // próximo skill no workflow
  requires: z.array(z.string()).optional(), // skills prerequisitos
})
```

#### R7. Two-Stage Review

**Arquivo**: `src/workflow/review.ts` (já existe, refinar)

**Prompt para stage 1 (Spec Compliance):**
```markdown
## Stage 1: Does the implementation match the spec?

For each requirement in the plan:
- [ ] Is it implemented? (yes/no)
- [ ] Does it match the locked decision? (reference D-XX)
- [ ] Are deferred items absent?

DO NOT evaluate code quality yet. Only spec compliance.
```

**Prompt para stage 2 (Code Quality):**
```markdown
## Stage 2: Is the code production-quality?

Only run AFTER Stage 1 passes.

- [ ] Tests exist and pass
- [ ] No type errors
- [ ] No lint warnings
- [ ] Error handling complete
- [ ] Edge cases covered
- [ ] Performance acceptable
```

---

## 4. COMPARAÇÃO: ANTES vs DEPOIS

### Antes (Estado Atual)

```
User message → Intent classify → System prompt (antipatterns + hardgates as text)
→ Prompt loop (circuit breaker, budget tracking)
→ Task tool (tiering, parallel tracking, 3-strike recovery)
→ Read tool (coverage tracking)
```

### Depois (Com Refinamentos)

```
User message → Intent classify + Red flag detection
→ System prompt (antipatterns contextuais + hard gates ENFORCED via permissions)
→ Planning mode (decision fidelity check, deferred tracking, discovery levels)
→ Prompt loop (circuit breaker + deviation rules categorizadas)
→ Task tool (tiering + parallel + 3-strike + auto-fix Rules 1-3 + ask Rule 4)
→ Two-stage review (spec compliance ANTES de code quality)
→ Skill chaining (brainstorm → plan → execute → finish automaticamente)
→ Read tool (coverage tracking)
→ Session end (instinct extraction → memory persistence)
```

---

## 5. OBSERVAÇÕES DO CÓDIGO REAL

### 5.1 Superpowers: Por que funciona

O segredo não é o YAML frontmatter ou as XML tags — é a **psicologia anti-racionalização**:

1. **Antecipa desculpas**: Cada skill lista as 10+ desculpas mais comuns e refuta ANTES do LLM pensar nelas
2. **Binário, não fuzzy**: "Delete code. Start over." — não há "considere", "talvez", "quando apropriado"
3. **Iron Laws**: Cada skill tem UMA regra que não pode ser quebrada, em CAPS
4. **Human signal detection**: Lista frases do usuário que indicam que o agent está errando

### 5.2 GSD: Por que funciona

O segredo é a **arquitetura de 3 camadas**:

1. **Orchestrators ficam thin** (~15% context): Parsear args → validar → spawnar agent → integrar resultado
2. **Agents recebem fresh 200K**: Cada executor começa com contexto limpo = qualidade máxima
3. **SDK centraliza estado**: Queries tipadas, não leitura ad-hoc de arquivos

### 5.3 ECC: Por que funciona

O segredo é a **abrangência + modularidade**:

1. **48 agents especializados**: Cada um faz UMA coisa bem
2. **183 skills composíveis**: Workflows reutilizáveis por stack
3. **Hook lifecycle completo**: PreToolUse, PostToolUse, SessionStart, Stop
4. **Security-first**: Kill switches, sandboxing, audit trail

### 5.4 OMO (oh-my-openagent): Por que funciona

O segredo é a **delegação com protocolo**:

1. **Intent gate ANTES de agir**: Classifica → roteia → valida → age
2. **6-section delegation prompt**: TASK, EXPECTED OUTCOME, REQUIRED TOOLS, MUST DO, MUST NOT DO, CONTEXT
3. **Anti-duplication**: Nunca fazer a mesma busca que delegou
4. **Oracle como safety net**: Consultor read-only para decisões difíceis

---

## 6. PRÓXIMOS PASSOS RECOMENDADOS

### Imediato (esta sessão)

1. **R1**: Hard gate enforcement via PermissionNext (integrar `hardgate.ts` com permissions reais)
2. **R5**: Red flags no `antipattern.ts` (adicionar REDFLAGS array)
3. **R2**: Deviation rules no prompt do task executor

### Próxima sessão

4. **R3**: Decision fidelity check no `planning.ts`
5. **R6**: Skill chaining (next/requires no frontmatter)
6. **R4**: Task granularity template no plan mode

### Futuro

7. **R7**: Two-stage review enforced
8. Hook recipes catálogo
9. Instinct extraction no obsidian-memory
10. Audit trail + kill switches

---

## APÊNDICE: Fontes de Código

| Repo | Análise | Profundidade |
|------|---------|-------------|
| obra/superpowers | 7 SKILL.md lidos completos, 371+ linhas cada | Code-level |
| gsd-build/get-shit-done | Commands, agents, SDK, workflows lidos | Code-level |
| affaan-m/everything-claude-code | README + guides + hooks + agents + security | Code-level |
| code-yeongyu/oh-my-openagent | Conhecimento direto (sou o Sisyphus) | Intimate |
| Yeachan-Heo/oh-my-claudecode | High-level da primeira análise | Overview |
| gadievron/raptor | High-level da primeira análise | Overview |

---

*Análise profunda gerada em 2026-04-16. 3 deep-dives completos + conhecimento direto do sistema.*
