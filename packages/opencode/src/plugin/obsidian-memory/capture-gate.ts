import { Log } from "../../util/log"
import { selectCandidates } from "./candidate-retrieval"
import { callHaiku } from "./haiku-client"
import { invalidateNote, rewriteNote, writeNote } from "./vault"
import type { MemoryKind, Scope } from "./types"
import { coerceMemoryKind } from "./types"

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
  private suggestThreshold: number
  private scopeResolver: (sessionID: string) => Promise<Scope | null>

  constructor(opts: {
    enabled: boolean
    model: string
    scopeResolver: (sessionID: string) => Promise<Scope | null>
    /**
     * Importance threshold above which ADD captures are routed to
     * `suggested/` for user approval instead of being committed directly.
     * 0 disables the feature (legacy behavior).
     */
    suggestThreshold?: number
  }) {
    this.enabled = opts.enabled
    this.model = opts.model
    this.suggestThreshold = opts.suggestThreshold ?? 0
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

    // Retrieve similar existing memories as candidates for UPDATE/DELETE
    const probeText = [
      userPrompt ?? "",
      ...batch.map((ev) => ev.summary),
    ]
      .filter(Boolean)
      .join(" ")
    const candidates = await selectCandidates(scope, { text: probeText }, { limit: 8 })
    const indexSnippets = candidates.map((c, i) => ({
      id: `cand_${i}`,
      path: c.entry.doc.path,
      title: c.entry.title,
      description: c.entry.description,
      tags: c.entry.tags,
    }))

    const payload = buildGateUserMessage(batch, userPrompt, indexSnippets)
    const result = await callHaiku({
      model: this.model,
      systemPrompt: GATE_SYSTEM_PROMPT,
      userMessage: payload,
      maxTokens: 1200,
      timeoutMs: 25_000,
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

    // Resolve candidate reference if present
    const targetCandidate =
      decision.targetId && decision.targetId.startsWith("cand_")
        ? indexSnippets[parseInt(decision.targetId.slice(5), 10)]
        : null

    try {
      await this.applyOp(scope, sessionID, decision, targetCandidate, batch.length, result.durationMs)
    } catch (err) {
      log.error("gate applyOp failed", {
        sessionID,
        op: decision.op,
        error: String(err),
      })
    }
  }

  private async applyOp(
    scope: Scope,
    sessionID: string,
    decision: GateDecision,
    targetCandidate: { path: string; title: string } | null,
    eventCount: number,
    durationMs: number,
  ): Promise<void> {
    if (decision.op === "NOOP") {
      log.info("gate decided NOOP", { sessionID, reason: decision.reason, events: eventCount })
      return
    }

    if (decision.op === "DELETE") {
      if (!targetCandidate) {
        log.info("gate DELETE without valid target — skipping", { sessionID, targetId: decision.targetId })
        return
      }
      const ok = await invalidateNote(scope, targetCandidate.path, {
        reason: decision.reason || "gate DELETE",
        supersededBy: decision.supersedes,
        commitMessage: `memory(invalidate): ${targetCandidate.title} — ${decision.reason || "gate"}`,
      })
      log.info("gate invalidated memory", { sessionID, path: targetCandidate.path, ok, duration: durationMs })
      return
    }

    if (decision.op === "UPDATE") {
      if (!targetCandidate) {
        log.info("gate UPDATE without valid target — falling back to ADD", { sessionID })
        decision.op = "ADD"
      } else {
        const linksBody = renderLinksBlock(decision.links)
        const fullBody = decision.body + (linksBody ? "\n\n" + linksBody : "")
        const ok = await rewriteNote(scope, targetCandidate.path, {
          body: fullBody,
          meta: {
            tags: decision.tags.join(","),
            importance: String(decision.importance ?? 0.5),
            links: JSON.stringify(decision.links),
            "memory-kind": decision.kind,
            "last-merged-count": String(eventCount),
          },
          commitMessage: `memory(update): ${targetCandidate.title} [gate importance=${decision.importance}]`,
        })
        log.info("gate updated memory", {
          sessionID,
          path: targetCandidate.path,
          ok,
          importance: decision.importance,
          kind: decision.kind,
          links: decision.links.length,
          duration: durationMs,
        })
        return
      }
    }

    // ADD (default + fallback from failed UPDATE)
    const linksBody = renderLinksBlock(decision.links)
    const fullBody = decision.body + (linksBody ? "\n\n" + linksBody : "")

    // Sidecar "suggest" mode: high-importance captures go to wip/suggested/
    // without committing, awaiting user approval via /memory approve.
    const goSuggest =
      this.suggestThreshold > 0 && decision.importance >= this.suggestThreshold
    const meta: Record<string, string> = {
      "memory-type": goSuggest ? "suggested" : "auto-capture",
      "memory-kind": decision.kind,
      source: "haiku-gate",
      importance: String(decision.importance ?? ""),
      tags: decision.tags.join(","),
      links: JSON.stringify(decision.links),
      "event-count": String(eventCount),
    }
    if (goSuggest) meta["suggested-at"] = new Date().toISOString()

    const filepath = await writeNote(scope, {
      title: decision.title,
      meta,
      body: fullBody,
      targetDir: goSuggest ? scope.suggestedDir : scope.notesDir,
      // No commit when in suggest mode — user decides via approve/reject
      skipCommit: goSuggest,
      commitMessage: goSuggest
        ? undefined
        : `memory(auto): capture "${decision.title}" [gate importance=${decision.importance}]`,
    })
    log.info(goSuggest ? "gate suggested memory" : "gate captured memory", {
      sessionID,
      filepath,
      kind: decision.kind,
      importance: decision.importance,
      tags: decision.tags,
      links: decision.links.length,
      suggested: goSuggest,
      duration: durationMs,
    })
  }
}

/**
 * Render a Markdown bullet list of wikilinks for embedding in the body.
 * Keeps the format consistent so the `parseLinks` reader picks them up
 * alongside the frontmatter `links` field.
 */
function renderLinksBlock(links: string[]): string {
  if (!links || links.length === 0) return ""
  const bullets = links.map((link) => `- [[${link}]]`).join("\n")
  return "## Related\n" + bullets
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

const GATE_SYSTEM_PROMPT = `You are a memory-capture gate for a coding assistant that manages a
persistent markdown vault (Obsidian-style).

You receive: (1) the user's latest intent, (2) a batch of tool events from
the current session, and (3) a list of existing CANDIDATE memories that are
similar to the new batch (retrieved by simple token overlap).

Your job is to choose ONE operation:

- "ADD"    — none of the candidates match; create a new memory
- "UPDATE" — a candidate covers the same topic; merge the new info in-place
- "DELETE" — a candidate is now contradicted / obsolete and should be marked invalid
- "NOOP"   — nothing here is worth remembering (be conservative)

Be AGGRESSIVE with NOOP. Only save surprising gotchas, non-obvious decisions,
procedural skills (how-to), or facts the next session would clearly benefit
from knowing. Skip routine file reads, greps, normal edits.

For ADD and UPDATE, you MUST enumerate 2-5 wikilinks to related candidates
(use their "title" field) so the vault becomes a connected graph.

Categorize "kind" as one of: fact, decision, gotcha, skill, episode, convention.

Output STRICTLY valid JSON matching this shape, no markdown fences, no prose:

{
  "op": "ADD" | "UPDATE" | "DELETE" | "NOOP",
  "reason": "one-line why",
  "targetId": "cand_0" | "cand_1" | ... (only if UPDATE or DELETE),
  "kind": "fact",
  "title": "short kebab-ish title (ADD/UPDATE)",
  "body": "markdown body <= 40 lines (ADD/UPDATE, cite code paths)",
  "tags": ["tag1", "tag2"],
  "links": ["candidate title 1", "candidate title 2"],
  "supersedes": "candidate title" (only DELETE, optional),
  "importance": 0.7
}

When op=NOOP, only "op" and "reason" are required.

Importance scale: 0.1 = trivial, 0.5 = useful context, 0.9 = critical gotcha.`

function buildGateUserMessage(
  batch: CaptureEventInput[],
  userPrompt: string | undefined,
  candidates: Array<{ id: string; title: string; description: string; tags: string[] }>,
): string {
  const parts: string[] = []
  if (userPrompt) {
    parts.push(`User's last intent:\n${userPrompt}`)
    parts.push("")
  }

  if (candidates.length > 0) {
    parts.push(`Existing candidates (${candidates.length}) — prefer UPDATE/DELETE over ADD if one matches:`)
    for (const c of candidates) {
      const tags = c.tags.length > 0 ? ` #${c.tags.join(" #")}` : ""
      parts.push(`- ${c.id}: "${c.title}" — ${c.description}${tags}`)
    }
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
  op: "ADD" | "UPDATE" | "DELETE" | "NOOP"
  reason: string
  targetId?: string
  kind: MemoryKind
  title: string
  body: string
  tags: string[]
  links: string[]
  supersedes?: string
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
    const parsed = JSON.parse(cleaned) as Partial<GateDecision> & {
      save?: boolean
    }

    // Back-compat: old "save: bool" → ADD/NOOP
    let op = parsed.op
    if (!op && typeof parsed.save === "boolean") {
      op = parsed.save ? "ADD" : "NOOP"
    }
    if (op !== "ADD" && op !== "UPDATE" && op !== "DELETE" && op !== "NOOP") {
      return null
    }

    return {
      op,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      targetId: typeof parsed.targetId === "string" ? parsed.targetId : undefined,
      kind: coerceMemoryKind(typeof parsed.kind === "string" ? parsed.kind : undefined),
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      tags: Array.isArray(parsed.tags)
        ? (parsed.tags as string[]).filter((t) => typeof t === "string")
        : [],
      links: Array.isArray(parsed.links)
        ? (parsed.links as string[]).filter((l) => typeof l === "string")
        : [],
      supersedes: typeof parsed.supersedes === "string" ? parsed.supersedes : undefined,
      importance: typeof parsed.importance === "number" ? parsed.importance : 0.5,
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
