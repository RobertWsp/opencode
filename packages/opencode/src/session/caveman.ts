import { Intent } from "../agent/intent"
import { Config } from "../config/config"

/**
 * Caveman — experimental terse-output mode inspired by
 * https://github.com/JuliusBrussee/caveman
 *
 * Injects a compact system-prompt rule that makes the model drop filler,
 * articles and pleasantries on *specific* task intents (research,
 * investigation, evaluation by default). Code/implementation tasks and
 * conversational replies are left untouched so production output quality
 * is not harmed. Safety-critical output (warnings, destructive actions)
 * auto-reverts to normal prose.
 */
export namespace Caveman {
  export type Level = "lite" | "full" | "ultra"

  export type Classifier = "regex" | "haiku"

  export type AgentOverride = { enabled?: boolean; level?: Level }

  export type Settings = {
    enabled: boolean
    level: Level
    intents: Intent.Type[]
    minMessageLength: number
    classifier: Classifier
    classifierTimeoutMs: number
    agents: Record<string, AgentOverride>
  }

  const PROSE_ARTIFACT_AGENTS: Record<string, AgentOverride> = {
    prometheus: { enabled: false },
    momus: { enabled: false },
    metis: { enabled: false },
  }

  const DEFAULT_INTENTS: Intent.Type[] = ["research", "investigation", "evaluation", "implementation", "fix"]
  const ALLOWED_LEVELS: Level[] = ["lite", "full", "ultra"]
  const ALLOWED_CLASSIFIERS: Classifier[] = ["regex", "haiku"]

  function normalizeLevel(value: string | undefined): Level | undefined {
    if (!value) return undefined
    const v = value.toLowerCase()
    return ALLOWED_LEVELS.includes(v as Level) ? (v as Level) : undefined
  }

  function normalizeClassifier(value: string | undefined): Classifier | undefined {
    if (!value) return undefined
    const v = value.toLowerCase()
    return ALLOWED_CLASSIFIERS.includes(v as Classifier) ? (v as Classifier) : undefined
  }

  const DEFAULT_ENABLED = false
  const DEFAULT_CLASSIFIER: Classifier = "haiku"
  const DEFAULT_TIMEOUT_MS = 3000

  function envEnabled(): boolean | undefined {
    const v = process.env["OPENCODE_EXPERIMENTAL_CAVEMAN"]?.toLowerCase()
    if (v === undefined) return undefined
    if (v === "false" || v === "0") return false
    if (v === "true" || v === "1") return true
    return undefined
  }

  export async function settings(): Promise<Settings> {
    const cfg = await Config.get()
    const raw = cfg.experimental?.caveman
    const enabled = raw?.enabled ?? envEnabled() ?? DEFAULT_ENABLED
    const level =
      normalizeLevel(process.env["OPENCODE_EXPERIMENTAL_CAVEMAN_LEVEL"]) ??
      (raw?.level as Level | undefined) ??
      "full"
    const intents = raw?.intents?.length ? (raw.intents as Intent.Type[]) : DEFAULT_INTENTS
    const minMessageLength = raw?.minMessageLength ?? 0
    const classifier =
      normalizeClassifier(process.env["OPENCODE_EXPERIMENTAL_CAVEMAN_CLASSIFIER"]) ??
      (raw?.classifier as Classifier | undefined) ??
      DEFAULT_CLASSIFIER
    const classifierTimeoutMs = raw?.classifierTimeoutMs ?? DEFAULT_TIMEOUT_MS
    const agents = (raw?.agents as Record<string, AgentOverride> | undefined) ?? {}
    return { enabled, level, intents, minMessageLength, classifier, classifierTimeoutMs, agents }
  }

  export function forAgent(s: Settings, agent?: string): Settings {
    if (!agent) return s
    const user = s.agents[agent]
    const builtin = PROSE_ARTIFACT_AGENTS[agent]
    const override = user ?? builtin
    if (!override) return s
    return {
      ...s,
      enabled: override.enabled ?? s.enabled,
      level: override.level ?? s.level,
    }
  }

  const DISABLE_PATTERNS: RegExp[] = [
    /\bno caveman\b/i,
    /\bstop caveman\b/i,
    /\bcaveman off\b/i,
    /\bnormal mode\b/i,
    /\bin (full |more |extra )?detail\b/i,
    /\bin depth\b/i,
    /\blong[ -]form\b/i,
    /\b((be|stay|keep)\s+verbose|verbose\s+(answer|response|output|reply|explanation|version|mode))\b/i,
    /\b(go|walk (me )?through )?step[- ]by[- ]step\b/i,
    /\bdetalhadamente\b/i,
    /\b(explique|explica|responda|descreva|explain|respond|describe) [\w ]{0,20}(em detalhes?|detalhad\w*|in detail)\b/i,
    /\bme (explique|explica|conte|descreva) [\w ]{0,20}(em detalhes?|detalhad\w*)\b/i,
    /\bpasso a passo\b/i,
    /\bexplique tudo\b/i,
    /\b(sem|tire) caveman\b/i,
    /\bmodo normal\b/i,
  ]

  const REENABLE_PATTERNS: RegExp[] = [
    /\bcaveman on\b/i,
    /\bcaveman (resume|restart)\b/i,
    /\b(turn|put) caveman (back )?on\b/i,
    /\b(ativar|ligar|voltar) caveman\b/i,
  ]

  export function disabledByMessage(message: string): boolean {
    if (!message) return false
    return DISABLE_PATTERNS.some((re) => re.test(message))
  }

  export function reenabledByMessage(message: string): boolean {
    if (!message) return false
    return REENABLE_PATTERNS.some((re) => re.test(message))
  }

  /**
   * Decide whether to activate caveman for the current turn.
   * Caller passes the classified intent and the raw user message.
   */
  export function shouldActivate(intent: Intent.Type, message: string, s: Settings): boolean {
    if (!s.enabled) return false
    if (!s.intents.includes(intent)) return false
    if (message.length < s.minMessageLength) return false
    if (disabledByMessage(message)) return false
    return true
  }

  const RULES_COMMON = [
    "Drop articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging.",
    "Technical terms exact. Code blocks unchanged. File paths unchanged. Errors quoted exact.",
    "Pattern: `[thing] [action] [reason]. [next step].`",
  ]

  const RULES_BY_LEVEL: Record<Level, string[]> = {
    lite: [
      "No filler/hedging. Keep articles and full sentences. Professional but tight.",
      ...RULES_COMMON,
    ],
    full: [
      "Drop articles, fragments OK, short synonyms (big not extensive, fix not 'implement a solution for').",
      ...RULES_COMMON,
    ],
    ultra: [
      "Abbreviate aggressively (DB/auth/config/req/res/fn/impl).",
      "Strip conjunctions, use arrows for causality (X -> Y), one word when one word enough.",
      ...RULES_COMMON,
    ],
  }

  const AUTO_CLARITY = [
    "Revert to normal prose for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, when the user asks to clarify or repeats a question.",
    "Resume caveman after clear part done.",
  ]

  const BOUNDARIES = [
    "SCOPE: caveman style applies ONLY to the free-form explanatory NARRATION you show the user around artifacts. It changes *how you talk*, not *how you think* and not *what you emit as artifact*.",
    "ARTIFACTS STAY NORMAL — DO NOT shorten, fragment, or caveman-ify: source code inside code blocks, file contents you write, commit messages, PR titles/bodies, diffs, test cases, JSDoc/TSDoc/docstrings, README/CHANGELOG/docs prose, migration guides, error messages quoted verbatim, plan content, task descriptions, tool call arguments, JSON schemas, structured output, internal reasoning/thinking tokens.",
    "If the user's TASK is to produce documentation/prose as the artifact (README, docs, guide, docstring, release notes), DO NOT use caveman — the doc is the deliverable and must be full prose.",
    "Reasoning quality, depth of investigation, number of tool calls, and accuracy of analysis MUST remain unchanged. Only the surface wording of the final user-facing narration is compressed.",
    "For code-producing tasks (implement/fix/refactor): narration around the code is caveman; the code itself is normal. Example OK: 'New func. Handles X. Here:' + [normal code block] + 'Test passes.'",
    "Safety/clarity overrides (see Auto-Clarity): security warnings, destructive actions, multi-step ordered instructions, user re-asking for clarification — revert to normal prose temporarily, then resume caveman.",
    "If the user says 'stop caveman' or 'normal mode' (any language), revert immediately for the rest of the session.",
  ]

  export function hint(level: Level): string {
    const rules = RULES_BY_LEVEL[level] ?? RULES_BY_LEVEL.full
    return [
      `<caveman-mode level="${level}">`,
      "Terse output mode active. Cut filler while preserving full technical accuracy.",
      "",
      "Rules:",
      ...rules.map((r) => `- ${r}`),
      "",
      "Auto-clarity:",
      ...AUTO_CLARITY.map((r) => `- ${r}`),
      "",
      "Boundaries:",
      ...BOUNDARIES.map((r) => `- ${r}`),
      "</caveman-mode>",
    ].join("\n")
  }
}
