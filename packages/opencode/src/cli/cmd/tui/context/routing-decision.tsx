import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { homedir } from "os"
import { join } from "path"

/**
 * RoutingDecision context — surfaces the model-router's latest decision
 * to the TUI (footer status line + inspector modal).
 *
 * Source of truth: the JSONL decision log at
 *   ~/.local/share/meridian/routing-decisions.jsonl
 *
 * Strategy: on mount, start a polling timer (every 2s by default) that
 * reads the tail of the file and parses the most recent decision record
 * for the currently active sessionID. The file is appended only, so tail
 * reads are cheap.
 *
 * Alternative designs considered:
 *   - SDK event bus: requires coordinated plugin-side emitter; heavier.
 *   - Inotify/fs.watch: works but is platform-dependent and Bun's watch
 *     API has gotchas. Polling at 2s is perfectly fine — decisions don't
 *     change faster than turns.
 *   - Reading only when a modal opens: loses the always-visible footer UX.
 */

export type TierBadge = "haiku" | "sonnet" | "opus" | "opus-plan"

export interface TaskAnalysis {
  task_type: string
  reasoning_depth: string
  scope_breadth: string
  estimated_files_touched: number | null
  context_requirements: string
  ambiguity: string
  ambiguity_reasons: string[]
  risk_level: string
  risk_justification: string
  novelty: string
  detected_technologies: string[]
  domain_expertise: string
  iteration_profile: string
  recommended_model: string
  confidence: number
  primary_reasoning: string
  contrarian_check: string
  task_type_evidence?: string
  reasoning_depth_evidence?: string
}

export interface RoutingDecisionRecord {
  timestamp: number
  sessionID: string
  turnNumber: number
  agent: string
  tier: TierBadge
  modelID: string
  providerID: string
  reasons: string[]
  analysis: TaskAnalysis | null
  analyzer: {
    used: boolean
    durationMs: number
    model: string
    fallbackUsed: boolean
    cached: boolean
    error?: string
  }
  confidence: number
}

const LOG_PATH = join(homedir(), ".local/share/meridian/routing-decisions.jsonl")
const POLL_INTERVAL_MS = 2_000
const TAIL_BYTES = 64 * 1024 // read last 64KB — enough for ~200 recent decisions

/**
 * Context-wide state:
 *   - lastDecision: the most recent decision for the active session
 *   - override: manual model pin from /model slash command
 *   - statsCache: aggregated stats for /model stats
 */
export const { use: useRoutingDecision, provider: RoutingDecisionProvider } = createSimpleContext({
  name: "RoutingDecision",
  init: () => {
    const [store, setStore] = createStore<{
      lastDecision: RoutingDecisionRecord | null
      activeSessionID: string | null
      override: { tier: TierBadge; until: "session" | "turn" } | null
    }>({
      lastDecision: null,
      activeSessionID: null,
      override: null,
    })

    async function refresh() {
      try {
        const content = await tailFile(LOG_PATH, TAIL_BYTES)
        if (!content) return
        const sessionID = store.activeSessionID
        const last = parseLastDecisionForSession(content, sessionID)
        if (last) {
          setStore("lastDecision", last)
        }
      } catch {
        // Log may not exist yet — fine
      }
    }

    let timer: ReturnType<typeof setInterval> | null = null

    onMount(() => {
      // Initial read + interval polling
      refresh()
      timer = setInterval(refresh, POLL_INTERVAL_MS)
    })

    onCleanup(() => {
      if (timer) clearInterval(timer)
    })

    return {
      lastDecision: () => store.lastDecision,
      override: () => store.override,
      setActiveSession(sessionID: string | null) {
        if (store.activeSessionID === sessionID) return
        setStore("activeSessionID", sessionID)
        setStore("lastDecision", null)
        refresh()
      },
      setOverride(tier: TierBadge, until: "session" | "turn" = "session") {
        setStore("override", { tier, until })
      },
      clearOverride() {
        setStore("override", null)
      },
      async refresh() {
        await refresh()
      },
      /** Returns decisions for the active session (last ~100) for stats modal. */
      async getAllDecisionsForSession(): Promise<RoutingDecisionRecord[]> {
        try {
          const content = await tailFile(LOG_PATH, TAIL_BYTES * 4)
          if (!content) return []
          return parseAllDecisionsForSession(content, store.activeSessionID)
        } catch {
          return []
        }
      },
    }
  },
})

// ─────────────────────────────────────────────────────────────────────────────

async function tailFile(path: string, bytes: number): Promise<string | null> {
  try {
    // Read the last `bytes` bytes of the file. For safety, read the whole
    // thing if smaller. This is fine at 64KB — one syscall.
    const fullContent = await Bun.file(path).text()
    if (fullContent.length <= bytes) return fullContent
    return fullContent.slice(fullContent.length - bytes)
  } catch {
    return null
  }
}

type LogEntry =
  | { kind: "decision"; ts: number; data: RoutingDecisionRecord }
  | { kind: "outcome"; ts: number; sessionID: string; decisionTs: number; data: unknown }

function parseLogLines(content: string): LogEntry[] {
  const lines = content.split("\n").filter((l) => l.trim())
  const out: LogEntry[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as LogEntry)
    } catch {
      // Partial line (buffer boundary) — skip
    }
  }
  return out
}

function parseLastDecisionForSession(content: string, sessionID: string | null): RoutingDecisionRecord | null {
  const entries = parseLogLines(content)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!e || e.kind !== "decision") continue
    if (sessionID && e.data.sessionID !== sessionID) continue
    return e.data
  }
  return null
}

function parseAllDecisionsForSession(content: string, sessionID: string | null): RoutingDecisionRecord[] {
  const entries = parseLogLines(content)
  const out: RoutingDecisionRecord[] = []
  for (const e of entries) {
    if (e.kind !== "decision") continue
    if (sessionID && e.data.sessionID !== sessionID) continue
    out.push(e.data)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render helpers for tier badges + status line.
 */
export function formatStatusLine(decision: RoutingDecisionRecord | null, override: TierBadge | null): string {
  if (override) return `pin:${override}`
  if (!decision) return ""
  const reason = pickPrimaryReason(decision.reasons)
  const conf = decision.confidence > 0 ? ` (${decision.confidence.toFixed(2)})` : ""
  return `${decision.tier} ← ${reason}${conf}`
}

export function formatTierShort(tier: TierBadge): string {
  switch (tier) {
    case "opus":
      return "◆ opus"
    case "sonnet":
      return "◇ sonnet"
    case "haiku":
      return "· haiku"
    case "opus-plan":
      return "◆/◇ opus-plan"
  }
}

function pickPrimaryReason(reasons: string[]): string {
  if (reasons.length === 0) return "default"
  const first = reasons[0] ?? "default"
  const colon = first.indexOf(":")
  if (colon > 0) return first.slice(colon + 1)
  return first
}
