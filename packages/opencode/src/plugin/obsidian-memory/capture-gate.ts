import { Log } from "../../util/log"
import { callHaiku } from "./haiku-client"
import { writeNote } from "./vault"
import type { Scope } from "./types"

const log = Log.create({ service: "plugin.obsidian-memory.capture" })

/**
 * Auto-capture queue and Haiku-backed gate.
 *
 * Events from `tool.execute.after` accumulate in a per-session queue. After
 * a debounce window (default 5s) with no new events, the queue is flushed
 * to a single Haiku call that decides in one shot:
 *   1. Is there anything worth remembering here? (binary gate)
 *   2. If yes: summary + tags + suggested title + importance 0-1
 *
 * Noteworthy design choices:
 *
 * - **One Haiku call per batch**, not per event. Batching is critical for
 *   cost — a chatty session can fire 20+ tool calls in a minute.
 * - **Fast heuristic pre-filter**: events that are obviously trivial (ls,
 *   glob, simple reads) never enter the queue. This saves ~80% of gate calls.
 * - **Circuit breaker**: after 3 consecutive Haiku errors/429s, pause the
 *   gate for 2 minutes. Memory capture never blocks the main session.
 * - **Write-behind**: save happens asynchronously from the triggering event.
 *   If the plugin is torn down mid-flush, we lose at most one batch.
 * - **Best-effort**: every error path swallows silently and logs — this
 *   subsystem must never crash the host.
 */

export interface CaptureEventInput {
  kind: "tool.after" | "session.error" | "user.message"
  sessionID: string
  summary: string
  /** Optional deeper payload — tool name, file paths, error text */
  details?: Record<string, unknown>
  timestamp: number
}

interface QueueState {
  events: CaptureEventInput[]
  timer: NodeJS.Timeout | null
  flushing: boolean
  lastUserPrompt?: string
}

interface CircuitBreaker {
  consecutiveFailures: number
  pausedUntil: number
}

const DEBOUNCE_MS = 5000
const BATCH_MIN_EVENTS = 1
const BATCH_MAX_EVENTS = 15
const MAX_TRIVIAL_BEFORE_FLUSH = 25
const CIRCUIT_FAIL_THRESHOLD = 3
const CIRCUIT_PAUSE_MS = 2 * 60 * 1000

export class CaptureGate {
  private queues = new Map<string, QueueState>()
  private breaker: CircuitBreaker = { consecutiveFailures: 0, pausedUntil: 0 }
  private enabled: boolean
  private model: string
  private scopeResolver: (sessionID: string) => Promise<Scope | null>

  constructor(opts: {
    enabled: boolean
    model: string
    scopeResolver: (sessionID: string) => Promise<Scope | null>
  }) {
    this.enabled = opts.enabled
    this.model = opts.model
    this.scopeResolver = opts.scopeResolver
  }

  /**
   * Record a user prompt so we can use it as context when deciding what
   * is worth remembering from subsequent tool calls.
   */
  noteUserPrompt(sessionID: string, prompt: string): void {
    if (!this.enabled) return
    const q = this.getQueue(sessionID)
    q.lastUserPrompt = prompt.slice(0, 500)
  }

  /**
   * Enqueue an event. Trivial events are filtered here; meaningful ones
   * start the debounce timer.
   */
  enqueue(ev: CaptureEventInput): void {
    if (!this.enabled) return
    if (this.isPaused()) return
    if (isTrivial(ev)) return

    const q = this.getQueue(ev.sessionID)
    if (q.events.length >= BATCH_MAX_EVENTS) {
      // Flush immediately when queue is full to avoid unbounded growth
      this.scheduleFlush(ev.sessionID, 0)
      return
    }
    q.events.push(ev)
    this.scheduleFlush(ev.sessionID, DEBOUNCE_MS)
  }

  /**
   * Force a flush for a session (e.g. on session.idle). Debounces are
   * cancelled and a single Haiku call is made with whatever is queued.
   */
  async flush(sessionID: string): Promise<void> {
    if (!this.enabled) return
    const q = this.queues.get(sessionID)
    if (!q || q.events.length < BATCH_MIN_EVENTS || q.flushing) return

    if (q.timer) {
      clearTimeout(q.timer)
      q.timer = null
    }

    q.flushing = true
    const batch = q.events.splice(0, BATCH_MAX_EVENTS)
    try {
      await this.runGate(sessionID, batch, q.lastUserPrompt)
    } catch (err) {
      log.error("flush crashed", { sessionID, error: String(err) })
    } finally {
      q.flushing = false
    }
  }

  /**
   * Drop all pending state for a session (session.deleted / compacted).
   */
  forget(sessionID: string): void {
    const q = this.queues.get(sessionID)
    if (q?.timer) clearTimeout(q.timer)
    this.queues.delete(sessionID)
  }

  private getQueue(sessionID: string): QueueState {
    let q = this.queues.get(sessionID)
    if (!q) {
      q = { events: [], timer: null, flushing: false }
      this.queues.set(sessionID, q)
    }
    return q
  }

  private scheduleFlush(sessionID: string, delayMs: number): void {
    const q = this.getQueue(sessionID)
    if (q.timer) clearTimeout(q.timer)
    q.timer = setTimeout(() => {
      q.timer = null
      void this.flush(sessionID)
    }, delayMs)
  }

  private isPaused(): boolean {
    return this.breaker.pausedUntil > Date.now()
  }

  private recordSuccess(): void {
    this.breaker.consecutiveFailures = 0
    this.breaker.pausedUntil = 0
  }

  private recordFailure(reason: string): void {
    this.breaker.consecutiveFailures++
    if (this.breaker.consecutiveFailures >= CIRCUIT_FAIL_THRESHOLD) {
      this.breaker.pausedUntil = Date.now() + CIRCUIT_PAUSE_MS
      log.warn("circuit breaker tripped — pausing capture gate", {
        reason,
        pauseMs: CIRCUIT_PAUSE_MS,
      })
    }
  }

  private async runGate(
    sessionID: string,
    batch: CaptureEventInput[],
    userPrompt: string | undefined,
  ): Promise<void> {
    const scope = await this.scopeResolver(sessionID)
    if (!scope) return

    const payload = buildGateUserMessage(batch, userPrompt)
    const result = await callHaiku({
      model: this.model,
      systemPrompt: GATE_SYSTEM_PROMPT,
      userMessage: payload,
      maxTokens: 800,
      timeoutMs: 20_000,
    })

    if (!result.ok) {
      this.recordFailure(result.error ?? "unknown")
      log.info("gate call failed", {
        sessionID,
        error: result.error,
        duration: result.durationMs,
      })
      return
    }

    this.recordSuccess()
    const decision = parseGateResponse(result.text ?? "")
    if (!decision) {
      log.debug("gate decision unparseable", {
        sessionID,
        sample: (result.text ?? "").slice(0, 100),
      })
      return
    }
    if (!decision.save) {
      log.info("gate decided not to save", {
        sessionID,
        reason: decision.reason,
        events: batch.length,
      })
      return
    }

    try {
      const filepath = await writeNote(scope, {
        title: decision.title,
        meta: {
          "memory-type": "auto-capture",
          source: "haiku-gate",
          importance: String(decision.importance ?? ""),
          tags: decision.tags.join(","),
          "event-count": String(batch.length),
        },
        body: decision.body,
        commitMessage: `memory(auto): capture "${decision.title}" [gate importance=${decision.importance}]`,
      })
      log.info("gate captured memory", {
        sessionID,
        filepath,
        importance: decision.importance,
        tags: decision.tags,
        duration: result.durationMs,
      })
    } catch (err) {
      log.error("gate writeNote failed", { sessionID, error: String(err) })
    }
  }
}

// ─── heuristic pre-filter ─────────────────────────────────────────────

/**
 * Drop events that are obviously not worth a Haiku call. This is the
 * cheapest optimization possible — reading a file in `src/` is usually
 * just navigation, not learning.
 */
function isTrivial(ev: CaptureEventInput): boolean {
  if (ev.kind !== "tool.after") return false
  const tool = (ev.details?.["tool"] ?? "") as string
  const triviallyBoring = new Set([
    "ls",
    "glob",
    "grep",
    "websearch",
    "webfetch",
    "read",
    "codesearch",
  ])
  if (triviallyBoring.has(tool.toLowerCase())) return true
  return false
}

// ─── gate prompt ────────────────────────────────────────────────────────

const GATE_SYSTEM_PROMPT = `You are a memory-capture gate for a coding assistant.

Given a batch of tool events plus the user's latest intent, decide whether
anything in this batch is worth saving as durable memory for this repository.
Be conservative: skip anything routine. Save only surprising gotchas,
non-obvious decisions, or facts that the next session of this assistant
would benefit from knowing.

Output STRICTLY valid JSON matching this shape, no markdown fences, no prose:

{
  "save": boolean,
  "reason": "one-line why-or-why-not",
  "title": "short kebab-ish title (only if save=true)",
  "body": "multi-line markdown (only if save=true, <= 40 lines, can cite paths)",
  "tags": ["tag1", "tag2"],
  "importance": 0.0
}

When save=false, only "save" and "reason" are required.

Importance scale: 0.1 = minor note, 0.5 = useful context, 0.9 = critical gotcha.`

function buildGateUserMessage(
  batch: CaptureEventInput[],
  userPrompt: string | undefined,
): string {
  const parts: string[] = []
  if (userPrompt) {
    parts.push(`User's last intent:\n${userPrompt}`)
    parts.push("")
  }
  parts.push(`Tool events (${batch.length}):`)
  for (const ev of batch) {
    const details = ev.details ? ` [${JSON.stringify(ev.details).slice(0, 200)}]` : ""
    parts.push(`- ${ev.kind}: ${ev.summary}${details}`)
  }
  return parts.join("\n")
}

export interface GateDecision {
  save: boolean
  reason: string
  title: string
  body: string
  tags: string[]
  importance: number
}

export function parseGateResponse(raw: string): GateDecision | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Strip possible code fences
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  try {
    const parsed = JSON.parse(cleaned) as Partial<GateDecision>
    if (typeof parsed.save !== "boolean") return null
    return {
      save: parsed.save,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      tags: Array.isArray(parsed.tags) ? (parsed.tags as string[]).filter((t) => typeof t === "string") : [],
      importance: typeof parsed.importance === "number" ? parsed.importance : 0,
    }
  } catch {
    return null
  }
}

// Exposed for testing
export const __internal = {
  isTrivial,
  buildGateUserMessage,
  DEBOUNCE_MS,
  CIRCUIT_FAIL_THRESHOLD,
  CIRCUIT_PAUSE_MS,
}
