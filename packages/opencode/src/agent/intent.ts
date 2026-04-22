import z from "zod"
import { callHaiku } from "../plugin/obsidian-memory/haiku-client"
import { Log } from "../util/log"

const log = Log.create({ service: "intent" })

export namespace Intent {
  export const Type = z.enum([
    "research",
    "implementation",
    "investigation",
    "evaluation",
    "fix",
    "documentation",
    "conversation",
  ])
  export type Type = z.infer<typeof Type>

  export type Source = "regex" | "haiku" | "haiku-fallback"

  export type Result = {
    type: Type
    confidence: number
    routing: string
    source: Source
  }

  export type Options = {
    classifier?: "regex" | "haiku"
    timeoutMs?: number
    model?: string
  }

  // Ordered by specificity. "fix" first (bug report containing "add" wins fix).
  // "documentation" BEFORE "implementation" so "write docs"/"escrever documentação" doesn't match "write"/"escrever" as impl.
  const patterns: Array<[Type, RegExp]> = [
    [
      "fix",
      /\b(fix|bugs?|errors?|broken|failing|crash(ed|ing)?|corrigir|corrig[eê]|corrija|corre[çc][aã]o|corre[çc][oõ]es|erros?|falhas?|quebrad[ao]s?|travad[ao]s?)\b/i,
    ],
    [
      "documentation",
      /\b((write|create|update|generate|draft|refresh|escrev[ae]r?|cri[ae]r?|atualiz[ae]r?|ger[ae]r?|redig[ae]r?|documentar) (the |a |an |some |o |os |as |um |uma |uns |umas |esta |este |estes |estas )?(docs?|documentation|document|documentação|readme|changelog|jsdoc|tsdoc|pydoc|comments?|coment[aá]rios?|guides?|guias?|tutorial|tutoriais|api docs|release notes|migration guide|onboarding))\b|\bdocument (the|this|a|an|it|function|module|class|method)\b|\bescrever (um |uma )?(documenta[cç][aã]o|readme|changelog|guia|tutorial|coment[aá]rios?)\b/i,
    ],
    [
      "implementation",
      /\b(implement|add|create|build|write|refactor|refactoring|scaffold|port|migrate|implementar|implementa[r]?|adicion[ae]r?|cri[ae]r?|escrev[ae]r?|fa[czç]er?|constru[ai]r?|montar|refator[ae]r?|refatoração)\b/i,
    ],
    [
      "research",
      /\b(explain|how does|what is|why|explic(a|ar|ou|am|amos|arão|ava|ando)|expliqu(e|em|ei|ou|emos|eram)|como (funciona|fazer)|o que (é|faz|significa)|por qu[eê])\b/i,
    ],
    [
      "investigation",
      /\b(look into|check|investigate|find|analy[sz]e|study|review|inspect|validate|identify|investig[ae]r?|verific[ae]r?|encontr[ae]r?|busc[ae]r?|checar|dar uma olhada|an[aá]lise|an[aá]lises|anális[ae]r?|analisar|analise|analisem|analisando|analisou|revis[aã]o|revis[oõ]es|revis[ae]r?|revise|revisem|estud[oa]|estudar|estude|estudem|estudando|pesquis[ae]r?|pesquisa|pesquise|pesquisas|valid[ae]r?|valida|valide|validem|identific[ae]r?|identifica|identifique|identifiquem|refin[ae]r?|refina|refine|examin[ae]r?|examina|examine|inspecion[ae]r?|inspeciona|inspecione)\b/i,
    ],
    [
      "evaluation",
      /\b(what do you think|evaluate|compare|avali[ae]r?|compar[ae]r?|o que (você )?(acha|pensa))\b/i,
    ],
  ]

  function detect(msg: string): Type {
    for (const [type, re] of patterns) if (re.test(msg)) return type
    return "conversation"
  }

  function agentFor(type: Type): string {
    if (type === "research" || type === "investigation") return "explore"
    if (type === "implementation" || type === "fix") return "build"
    if (type === "evaluation") return "general"
    if (type === "documentation") return "build"
    return "build"
  }

  const CACHE_MAX = 128
  const CACHE_TTL_MS = 5 * 60 * 1000
  const cache = new Map<string, { result: Result; at: number }>()

  function key(msg: string, mode: string) {
    return `${mode}:${msg.slice(0, 500)}`
  }

  function get(k: string): Result | undefined {
    const hit = cache.get(k)
    if (!hit) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      cache.delete(k)
      return undefined
    }
    cache.delete(k)
    cache.set(k, hit)
    return hit.result
  }

  function set(k: string, result: Result) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest) cache.delete(oldest)
    }
    cache.set(k, { result, at: Date.now() })
  }

  export function _resetCache() {
    cache.clear()
  }

  const HAIKU_SYSTEM = `You classify ONE user message into ONE intent. Output ONLY a single JSON object — no prose before or after, no markdown, no backticks, no explanation. Do not answer the user's question; classify it.

Schema: {"type": "research"|"implementation"|"investigation"|"evaluation"|"fix"|"documentation"|"conversation", "confidence": number 0..1}

Rules:
- Classify by PRIMARY VERB and USER GOAL. Ignore polite suffixes ("corretamente porfavor", "please", "por favor", "thank you", "obrigado"), typos, vague pronouns ("isso", "this"), and casual phrasing.
- An imperative work request ("faça X", "write Y", "Corrigir Z") is NEVER "conversation" — even if short or polite.
- A filename mention (README, CHANGELOG, foo.ts) does NOT force "documentation". The verb decides: "analyze README" = investigation, "write README" = documentation.
- Be decisive. Prefer confidence ≥ 0.85 for clear imperatives.

Concrete examples:

research — user wants conceptual EXPLANATION
  "Explique como OAuth funciona"            → research
  "o que é TypeScript satisfies"            → research
  "why does useMemo prevent re-renders?"    → research

implementation — user wants NEW code produced (includes refactor/port/migrate)
  "Implementar função debounce"             → implementation
  "refactor auth architecture"              → implementation
  "Faça todas as implementações no sistema" → implementation
  "add a debounce util"                     → implementation

investigation — user wants model to INSPECT / ANALYZE / REVIEW / VALIDATE / IDENTIFY / STUDY existing code or system
  "faça uma análise detalhada do sistema"   → investigation
  "faça um estudo detalhado"                → investigation
  "estude em detalhes o sistema"            → investigation
  "revise o PR"                             → investigation
  "Análise cada sessão do README.md"        → investigation  (verb = analyze; README is object)
  "valide o sistema"                        → investigation
  "identifique os padrões"                  → investigation
  "pesquise no codebase / sobre o sistema"  → investigation
  "look into why X"                         → investigation
  "teste e valide o sistema"                → investigation
  "você precisa teste e valide"             → investigation

evaluation — user wants OPINION / COMPARISON / TRADEOFF
  "o que você acha de Zustand vs Redux"     → evaluation
  "compare React Query and SWR"             → evaluation

fix — user REPORTS BUG or asks to correct broken behavior
  "Fix the null pointer"                    → fix
  "Corrigir o erro X"                       → fix
  "faça a correção do sistema"              → fix
  "o login tá quebrando"                    → fix

documentation — user wants PROSE ARTIFACT produced (output IS the doc)
  "escrever a documentação de X"            → documentation
  "write a README for grogu CLI"            → documentation
  "atualizar o CHANGELOG"                   → documentation
  "gere JSDoc para foo.ts"                  → documentation

conversation — ONLY meta-chat / greeting / ack / pure continuation
  "hi" / "olá" / "thanks" / "obrigado"      → conversation
  "continuar" / "continue"                  → conversation
  "got it" / "entendi"                      → conversation

Disambiguation:
- "pesquise [generic world topic]"         → research
- "pesquise [our code / our system]"       → investigation
- "valide [external opinion/idea]"         → evaluation
- "valide [sistema / code / working state]" → investigation
- Mixed verbs → pick the DELIVERABLE. "analisar e corrigir" → fix. "implement and explain" → implementation.

Respect the user's language.`

  const HAIKU_MODEL = "claude-haiku-4-5-20251001"

  async function classifyHaiku(msg: string, timeoutMs: number, model: string): Promise<Result | undefined> {
    const out = await callHaiku({
      model,
      systemPrompt: HAIKU_SYSTEM,
      userMessage: msg,
      maxTokens: 80,
      timeoutMs,
    })
    if (!out.ok || !out.text) {
      log.warn("haiku classifier failed", { error: out.error, ms: out.durationMs })
      return undefined
    }
    const raw = out.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "")
    const first = raw.indexOf("{")
    const last = raw.lastIndexOf("}")
    const candidate = first >= 0 && last > first ? raw.slice(first, last + 1) : raw
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      log.warn("haiku classifier produced non-json", { snippet: raw.slice(0, 200) })
      return undefined
    }
    const obj = parsed as { type?: string; confidence?: number }
    const check = Type.safeParse(obj.type)
    if (!check.success) return undefined
    const type = check.data
    const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.7
    return { type, confidence, routing: agentFor(type), source: "haiku" }
  }

  export async function classify(message: string, opts: Options = {}): Promise<Result> {
    const msg = message.toLowerCase()
    const mode = opts.classifier ?? "regex"
    const k = key(msg, mode)
    const hit = get(k)
    if (hit) return hit

    if (mode === "haiku") {
      const out = await classifyHaiku(message, opts.timeoutMs ?? 3000, opts.model ?? HAIKU_MODEL)
      if (out) {
        set(k, out)
        return out
      }
      const type = detect(msg)
      const result: Result = { type, confidence: 0.5, routing: agentFor(type), source: "haiku-fallback" }
      set(k, result)
      return result
    }

    const type = detect(msg)
    const result: Result = { type, confidence: 0.8, routing: agentFor(type), source: "regex" }
    set(k, result)
    return result
  }

  export function classifySync(message: string): Result {
    const type = detect(message.toLowerCase())
    return { type, confidence: 0.8, routing: agentFor(type), source: "regex" }
  }

  export function route(result: Result): string {
    return agentFor(result.type)
  }

  export function hint(result: Result): string {
    if (result.type === "research") return "Focus on explaining concepts clearly with examples."
    if (result.type === "implementation") return "Write clean, production-ready code following project conventions."
    if (result.type === "investigation") return "Explore the codebase thoroughly before drawing conclusions."
    if (result.type === "evaluation") return "Provide balanced analysis with concrete trade-offs."
    if (result.type === "fix") return "Identify the root cause before proposing a fix."
    if (result.type === "documentation")
      return "Produce documentation prose as the primary artifact: complete sentences, clear structure, reader-friendly."
    return "Respond conversationally and helpfully."
  }
}
