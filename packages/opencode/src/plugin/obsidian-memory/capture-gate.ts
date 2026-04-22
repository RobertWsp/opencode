import { Log } from "../../util/log"
import type { Embedder } from "./embedder"
import type { VectorStore } from "./vector-store"
import { loadAllEntries, selectCandidates } from "./candidate-retrieval"
import { callHaiku } from "./haiku-client"
import { detectContradiction, markSuperseded } from "./contradiction"
import { isValidAt, titleToSlug, toEntry } from "./parse-entry"
import { enrichWithTaskRefs } from "./task-linker"
import { invalidateNote, rewriteNote, writeNote } from "./vault"
import { stripPrivate, sanitizeRecord } from "./privacy"
import type { Confidence, MemoryEntry, MemoryKind, Scope } from "./types"
import { coerceConfidence, coerceMemoryKind } from "./types"

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
  kind: "tool.after" | "session.error" | "user.message" | "chat.response"
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
  pendingResolvers?: Array<() => void>
  recentHashes?: Map<string, number>
  fileReadCount?: Map<string, number>
}

interface CircuitBreaker {
  consecutiveFailures: number
  pausedUntil: number
}

const DEBOUNCE_MS = 800
const BATCH_MIN_EVENTS = 1
const BATCH_MAX_EVENTS = 15
const MAX_TRIVIAL_BEFORE_FLUSH = 25
const CIRCUIT_FAIL_THRESHOLD = 3
const CIRCUIT_PAUSE_MS = 2 * 60 * 1000
/** Events past this count trigger an IMMEDIATE inline flush */
const IMMEDIATE_FLUSH_THRESHOLD = 3

export class CaptureGate {
  private queues = new Map<string, QueueState>()
  private breaker: CircuitBreaker = { consecutiveFailures: 0, pausedUntil: 0 }
  private enabled: boolean
  private model: string
  private suggestThreshold: number
  private contradictionDetection: boolean
  private scopeResolver: (sessionID: string) => Promise<Scope | null>
  private embedder: Embedder | null
  private getVectorStore: (() => VectorStore | undefined) | undefined
  private dryRun = false
  private stats = {
    received: 0,
    enqueued: 0,
    skippedTrivial: 0,
    skippedFiltered: 0,
    skippedPaused: 0,
    written: 0,
    suggested: 0,
    gateRejected: 0,
    haikuFailed: 0,
  }

  getStats() {
    return { ...this.stats }
  }

  constructor(opts: {
    enabled: boolean
    model: string
    scopeResolver: (sessionID: string) => Promise<Scope | null>
    suggestThreshold?: number
    contradictionDetection?: boolean
    embedder?: Embedder | null
    getVectorStore?: () => VectorStore | undefined
    dryRun?: boolean
  }) {
    this.enabled = opts.enabled
    this.dryRun = opts.dryRun ?? false
    this.model = opts.model
    this.suggestThreshold = opts.suggestThreshold ?? 0
    this.contradictionDetection = opts.contradictionDetection ?? true
    this.scopeResolver = opts.scopeResolver
    this.embedder = opts.embedder ?? null
    this.getVectorStore = opts.getVectorStore
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
   * start the debounce timer. Returns a promise that resolves when the
   * debounced flush (if triggered) finishes — callers that need
   * single-shot synchronous semantics (opencode run) can await this.
   *
   * Three paths are possible:
   * 1. Trivial event → filter, return empty Promise
   * 2. Queue < IMMEDIATE_FLUSH_THRESHOLD → schedule debounced flush (await it)
   * 3. Queue >= IMMEDIATE_FLUSH_THRESHOLD → flush inline immediately
   */
  async enqueue(ev: CaptureEventInput): Promise<void> {
    if (!this.enabled) return
    this.stats.received++
    if (this.isPaused()) {
      this.stats.skippedPaused++
      log.info("enqueue skipped: circuit breaker paused", { sessionID: ev.sessionID })
      return
    }
    if (isTrivial(ev)) {
      this.stats.skippedTrivial++
      log.info("enqueue skipped: trivial event", {
        sessionID: ev.sessionID,
        tool: ev.details?.["tool"],
      })
      return
    }

    ev.summary = stripPrivate(ev.summary)
    ev.details = sanitizeRecord(ev.details)

    const q = this.getQueue(ev.sessionID)
    if (isFilterable(ev, q)) {
      this.stats.skippedFiltered++
      log.info("enqueue skipped: filtered (dedup or file cap)", {
        sessionID: ev.sessionID,
        tool: ev.details?.["tool"],
      })
      return
    }
    this.stats.enqueued++
    log.info("enqueue accepted", {
      sessionID: ev.sessionID,
      tool: ev.details?.["tool"],
      kind: ev.kind,
      summary: ev.summary?.slice(0, 80),
      queueSize: q.events.length + 1,
    })
    q.events.push(ev)

    if (q.events.length >= IMMEDIATE_FLUSH_THRESHOLD || q.events.length >= BATCH_MAX_EVENTS) {
      // Cancel any pending debounce, flush inline now
      if (q.timer) {
        clearTimeout(q.timer)
        q.timer = null
      }
      await this.flush(ev.sessionID)
      return
    }

    // Schedule a debounced flush. All callers in the same debounce window
    // share a single promise so no caller is left dangling when the timer
    // is reset by a subsequent enqueue.
    if (q.timer) clearTimeout(q.timer)
    if (!q.pendingResolvers) q.pendingResolvers = []
    const p = new Promise<void>((resolve) => {
      q.pendingResolvers!.push(resolve)
    })
    q.timer = setTimeout(async () => {
      q.timer = null
      const resolvers = q.pendingResolvers?.splice(0) ?? []
      try {
        await this.flush(ev.sessionID)
      } finally {
        for (const resolve of resolvers) resolve()
      }
    }, DEBOUNCE_MS)
    return p
  }

  /**
   * Force a flush for a session (e.g. on session.idle). Debounces are
   * cancelled and a single Haiku call is made with whatever is queued.
   */
  async flush(sessionID: string, signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return
    const q = this.queues.get(sessionID)
    if (!q || q.events.length < BATCH_MIN_EVENTS || q.flushing) return

    if (q.timer) {
      clearTimeout(q.timer)
      q.timer = null
    }

    if (signal?.aborted) {
      log.info("abort received, cleaning up", { sessionID })
      return
    }

    q.flushing = true
    const batch = q.events.slice(0, BATCH_MAX_EVENTS)
    try {
      await this.runGate(sessionID, batch, q.lastUserPrompt, signal)
      // Only remove events after successful processing
      q.events.splice(0, Math.min(q.events.length, BATCH_MAX_EVENTS))
    } catch (err) {
      // Events remain in queue for retry on next flush
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

  /**
   * Schedule a fire-and-forget flush. Prefer `enqueue` which returns
   * an awaitable Promise; this helper remains for legacy call sites.
   */
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
    signal?: AbortSignal,
  ): Promise<void> {
    const scope = await this.scopeResolver(sessionID)
    if (!scope) return

    // Load ALL vault entries to build a complete title index for link validation.
    // This is cheap (~1ms for 100 notes) and ensures links reference real notes.
    const allEntries = await loadAllEntries(scope)
    const validEntries = allEntries.filter((e) => isValidAt(e))

    // Build a complete title index: both original titles and slugified forms,
    // so "JWT Expiry Gotcha" matches links written as "jwt-expiry-gotcha".
    const vaultTitleIndex = new Map<string, string>()
    for (const entry of validEntries) {
      vaultTitleIndex.set(entry.title.toLowerCase(), entry.title)
      vaultTitleIndex.set(titleToSlug(entry.title), entry.title)
    }

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

    // Collect ALL vault titles so Haiku can create valid links to any note
    const allTitles = validEntries.map((e) => e.title)

    const payload = buildGateUserMessage(batch, userPrompt, indexSnippets, allTitles)
    const result = await callHaiku({
      model: this.model,
      systemPrompt: GATE_SYSTEM_PROMPT,
      userMessage: payload,
      maxTokens: 1200,
      timeoutMs: 25_000,
      signal,
    })

    if (!result.ok) {
      this.stats.haikuFailed++
      this.recordFailure(result.error ?? "unknown")
      log.info("gate call failed", {
        sessionID,
        error: result.error,
        duration: result.durationMs,
        stats: this.stats,
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

    // Resolve candidate reference if present (with bounds check)
    let targetCandidate: typeof indexSnippets[number] | null = null
    if (decision.targetId && decision.targetId.startsWith("cand_")) {
      const idx = parseInt(decision.targetId.slice(5), 10)
      if (idx >= 0 && idx < indexSnippets.length) {
        targetCandidate = indexSnippets[idx]
      }
    }

    // Hard validation: only allow links that match a REAL title in the vault.
    // Matches against both the original title and its slug form so that
    // "JWT Expiry Gotcha" ↔ "jwt-expiry-gotcha" both resolve correctly.
    decision.links = decision.links.filter((link) => {
      const lower = link.toLowerCase()
      const slug = titleToSlug(link)
      return vaultTitleIndex.has(lower) || vaultTitleIndex.has(slug)
    })

    try {
      await this.applyOp(scope, sessionID, decision, targetCandidate, batch, result.durationMs, validEntries)
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
    batch: CaptureEventInput[],
    durationMs: number,
    nearby: MemoryEntry[] = [],
  ): Promise<void> {
    const eventCount = batch.length

    // Collect unique file paths from the batch events for the refs field.
    // These become searchable metadata — the retrieval system can boost
    // memories that mention files the agent is currently working on.
    const batchFiles = new Set<string>()
    for (const ev of batch) {
      const files = ev.details?.["files"]
      if (Array.isArray(files)) {
        for (const f of files) {
          if (typeof f === "string") batchFiles.add(f)
        }
      }
    }
    const refsValue = [...batchFiles].slice(0, 20).join(",")

    if (decision.op === "NOOP") {
      this.stats.gateRejected++
      log.info("gate decided NOOP", { sessionID, reason: decision.reason, events: eventCount, stats: this.stats })
      return
    }

    // ADD-only mode (mem0 v2 algorithm, +20pt accuracy): coerce UPDATE/DELETE
    // into ADD so memories accumulate instead of being mutated. Dedup happens
    // posthoc via similarity ranking in retrieval.
    if (decision.op === "DELETE" || decision.op === "UPDATE") {
      log.info("gate ADD-only mode: coercing op to ADD", { sessionID, originalOp: decision.op })
      decision.op = "ADD"
    }

    // Links are stored in frontmatter only — no body wikilinks to avoid
    // dangling [[links]] in Obsidian when targets don't exist yet.

    // Sidecar "suggest" mode: high-importance captures go to wip/suggested/
    // without committing, awaiting user approval via /memory approve.
    const goSuggest =
      this.suggestThreshold > 0 && decision.importance >= this.suggestThreshold
    const autoLinks = findSimilarSlugs(decision, nearby, 0.15, 3)
    const mergedLinks = Array.from(new Set([...decision.links, ...autoLinks]))
    const meta: Record<string, string> = {
      "memory-type": goSuggest ? "suggested" : "auto-capture",
      "memory-kind": decision.kind,
      source: "haiku-gate",
      importance: String(decision.importance ?? ""),
      tags: decision.tags.join(","),
      links: mergedLinks.join(","),
      refs: refsValue,
      "event-count": String(eventCount),
    }
    if (goSuggest) meta["suggested-at"] = new Date().toISOString()
    const commitMeta = extractCommitMeta(batch)
    if (commitMeta.commit) meta.commit = commitMeta.commit
    if (commitMeta.task) meta.task = commitMeta.task
    const probe = batch.map((ev) => ev.summary).join(" ") + " " + decision.title + " " + decision.body
    const rich = enrichWithTaskRefs(meta, probe)
    if (rich.task) meta.task = rich.task
    if (decision.confidence_tier) meta["confidence"] = decision.confidence_tier
    if (decision.confidence_score !== undefined) meta["confidence_score"] = String(decision.confidence_score)

    if (this.dryRun) {
      log.info("gate dryRun: would write memory (not persisted)", {
        sessionID,
        title: decision.title,
        kind: decision.kind,
        importance: decision.importance,
        suggested: goSuggest,
      })
      return
    }
    const filepath = await writeNote(scope, {
      title: decision.title,
      meta,
      body: decision.body,
      targetDir: goSuggest ? scope.suggestedDir : scope.notesDir,
      // No commit when in suggest mode — user decides via approve/reject
      skipCommit: goSuggest,
      commitMessage: goSuggest
        ? undefined
        : `memory(auto): capture "${decision.title}" [gate importance=${decision.importance}]`,
    })
    if (goSuggest) this.stats.suggested++
    else this.stats.written++
    log.info(goSuggest ? "gate suggested memory" : "gate captured memory", {
      sessionID,
      filepath,
      kind: decision.kind,
      importance: decision.importance,
      tags: decision.tags,
      links: decision.links.length,
      suggested: goSuggest,
      duration: durationMs,
      stats: this.stats,
    })

    const store = this.getVectorStore?.()
    if (this.embedder && store) {
      const emb = this.embedder
      const text = `${decision.title} ${decision.body}`.slice(0, 8000)
      void emb
        .embed([text])
        .then((results) => {
          const v = results[0]?.vector
          if (v) store.upsert(filepath, v)
        })
        .catch((_err) => {
          void _err
        })
    }

    if (this.contradictionDetection && !goSuggest && nearby.length > 0) {
      const newDoc = {
        path: filepath,
        meta: { title: decision.title, tags: decision.tags.join(","), "memory-kind": decision.kind },
        body: decision.body,
        mtimeMs: Date.now(),
        size: decision.body.length,
      }
      const newEntry = toEntry(newDoc)
      const contra = await detectContradiction(newEntry, nearby)
      if (contra) {
        await markSuperseded(contra.path, decision.title)
        log.info("gate marked superseded", {
          sessionID,
          old: contra.path,
          by: decision.title,
          sim: contra.similarity,
        })
      }
    }
  }
}

export function findSimilarSlugs(
  decision: { title: string; body: string },
  candidates: MemoryEntry[],
  threshold: number,
  max: number,
): string[] {
  if (candidates.length === 0) return []
  const newTokens = linkTokens(decision.title + " " + decision.body.slice(0, 500))
  const matches: Array<{ slug: string; sim: number }> = []
  for (const c of candidates) {
    if (c.supersededBy !== null || c.validUntil !== null) continue
    const oldTokens = linkTokens(c.title + " " + c.doc.body.slice(0, 500))
    const s = linkJaccard(newTokens, oldTokens)
    if (s < threshold) continue
    const slug = c.doc.path.split("/").pop()?.replace(/\.md$/, "") ?? ""
    if (slug) matches.push({ slug, sim: s })
  }
  matches.sort((a, b) => b.sim - a.sim)
  return matches.slice(0, max).map((m) => m.slug)
}

function linkTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 2))
}

function linkJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function extractCommitMeta(batch: CaptureEventInput[]): Record<string, string> {
  const ev = batch.find((e) => e.details?.subcommand === "commit" && e.details?.hash)
  if (!ev) return {}
  const meta: Record<string, string> = {}
  meta.commit = ev.details!.hash as string
  const refs = ev.details?.issueRefs as string[] | undefined
  if (refs && refs.length > 0) meta.task = refs.join(",")
  return meta
}

export function makeRevertGotcha(ev: CaptureEventInput): CaptureEventInput {
  const hash = ev.details?.hash as string | undefined
  const details: Record<string, unknown> = {
    tool: "git",
    subcommand: "revert",
    kind: "gotcha",
    importance: 0.9,
  }
  if (hash !== undefined) details.hash = hash
  return {
    kind: "tool.after",
    sessionID: ev.sessionID,
    summary: `git revert: This commit was reverted${hash ? ` (reverted: ${hash})` : ""}`,
    details,
    timestamp: ev.timestamp,
  }
}

// ─── heuristic pre-filter ─────────────────────────────────────────────

function isTrivial(ev: CaptureEventInput): boolean {
  if (ev.kind !== "tool.after") return false
  const tool = (ev.details?.["tool"] ?? "") as string
  const boring = new Set(["ls", "glob", "grep", "websearch", "webfetch", "read", "codesearch"])
  if (boring.has(tool.toLowerCase())) return true
  return false
}

// READ_ONLY_TOOLS is intentionally small here — the broader `isTrivial`
// filter already handles low-signal read tools upstream. This list is
// reserved for duplicate-class rejection only when a READ_ONLY tool is
// fired many times over the same file (see FILE_READ_MAX below).
const READ_ONLY_TOOLS = new Set([
  "lsp_diagnostics",
  "lsp_symbols",
  "lsp_goto_definition",
  "lsp_find_references",
])
// Deduplication window: drops repeated events with identical summary hash
// within this TTL. 5 minutes is enough to absorb rapid retries (same tool
// signature within a single reasoning loop) without losing distinct
// captures across a typical coding turn (~30s-2min).
const DEDUP_WINDOW_MS = 5 * 60 * 1000
// Max distinct events per file before additional hits are filtered.
// Raised from 3 → 10 because agent tasks commonly edit the same file
// many times within a single feature (small iterative edits, test fix,
// refactor passes). Below 10 we were losing 60-80% of capture signal.
const FILE_READ_MAX = 10

function normalizeHash(text: string): string {
  const s = text.toLowerCase().trim().replace(/\s+/g, " ")
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

function isFilterable(ev: CaptureEventInput, q: QueueState): boolean {
  const tool = (ev.details?.["tool"] as string | undefined) ?? ""

  // LSP diagnostic-class tools dedupe aggressively — they fire rapidly
  // during navigation and produce low-signal results.
  if (READ_ONLY_TOOLS.has(tool)) {
    const hash = normalizeHash(`${tool}:${ev.summary}`)
    if (!q.recentHashes) q.recentHashes = new Map()
    const last = q.recentHashes.get(hash)
    if (last !== undefined && Date.now() - last < DEDUP_WINDOW_MS) return true
    q.recentHashes.set(hash, Date.now())
    return false
  }

  // For all other tools, only dedupe when both tool AND summary match
  // within the window (not just summary alone). Different tools on the
  // same target should NOT be deduped against each other.
  const hash = normalizeHash(`${tool}:${ev.summary}`)
  if (!q.recentHashes) q.recentHashes = new Map()
  const last = q.recentHashes.get(hash)
  if (last !== undefined && Date.now() - last < DEDUP_WINDOW_MS) return true
  q.recentHashes.set(hash, Date.now())

  // Per-file overflow cap. Only applies to tools whose details include a
  // `files` array (read-like tools); edits on the same file are tracked
  // but each edit has a distinct summary/hash so dedupe handles it.
  const file = (ev.details?.["files"] as string[] | undefined)?.[0]
  if (file) {
    if (!q.fileReadCount) q.fileReadCount = new Map()
    const count = q.fileReadCount.get(file) ?? 0
    if (count >= FILE_READ_MAX) return true
    q.fileReadCount.set(file, count + 1)
  }

  return false
}

// ─── gate prompt ────────────────────────────────────────────────────────

const GATE_SYSTEM_PROMPT = `You are a memory-capture gate for a coding assistant that manages a persistent markdown vault (Obsidian-style).

You receive: (1) the user's latest intent, (2) a batch of tool events from the current session, (3) a list of existing CANDIDATE memories similar to the new batch, (4) the complete list of vault note titles.

Your job: choose ONE operation — ADD / UPDATE / DELETE / NOOP.

## EXTRACTION PRINCIPLES (mem0 v3)

1. **When in doubt, EXTRACT.** A slightly redundant memory is far less costly than a missing one. Downstream dedup + diversity handle duplicates. Over-NOOP is the failure mode — don't be excessively conservative.

2. **Contextually rich, NOT atomic.** Capture the full picture — fact + surrounding context — in ONE unified memory, not scattered fragments.
   BAD: "User uses JWT"
   GOOD: "Project chose JWT (15min access + 7d refresh) over session-cookies after rejecting server-side session overhead. Tokens in httpOnly cookies, implemented in src/auth/ on 2026-04-12."

3. **Preserve specific details — NEVER generalize.** Proper nouns, file paths, function names, package names, version numbers, quantities MUST survive into the body. Users search BY name — a memory without the name is unfindable.
   BAD: "Installed a router library"
   GOOD: "Installed @tanstack/react-router v1.91 (not react-router-dom); configured in src/router/index.ts with createFileRoute pattern"

4. **Capture transitions (delta, not just state).** When something changes, capture WHAT changed AND FROM WHAT. The relationship between old and new is the valuable context.
   BAD: "Uses bun:test for testing"
   GOOD: "Switched from vitest to bun:test on 2026-04-20 after flaky fake-timer issues; test files now use 'import { test } from \\"bun:test\\"' instead of vitest globals"

5. **Extract from BOTH user intent AND tool events.** Assistant-confirmed actions ('wrote X', 'fixed Y', 'decided Z') are as memorable as user statements. Don't skip capture just because it came from the tool output side.

6. **Incidental facts count.** If user mentions 'we use X on this project' as drive-by context while asking something else, extract that fact as its own memory — don't let the primary question overshadow the contextual fact.

7. **Temporal grounding.** When dates/durations appear in events, include them in the body ('on 2026-04-20', 'for 3 days', 'since v1.91'). Don't vaguely say 'recently' — pin concrete dates.

## WHAT JUSTIFIES NOOP (be honest)

- Routine file reads (cat/ls/read without subsequent decision)
- Trivial greps that found expected results
- Simple edits that don't change design
- Pure conversational filler with no decision/gotcha/fact

## WHAT TO EXTRACT (be generous)

- **Decisions** — "chose X over Y because Z"
- **Gotchas** — "X fails when Y because Z"
- **Conventions** — "we always/never do X in this codebase"
- **Procedures** — "to do X, run Y then Z"
- **External facts** — API behaviors, package quirks, config requirements
- **Contradictions** — new info conflicts with existing memory → UPDATE or DELETE

## FEW-SHOT EXAMPLES

### Example 1 — ADD (gotcha, rich context, specifics preserved)
Events: "ran bun test", "test failed: 'setTimeout is not defined'", "added 'import { setTimeout } from \\"node:timers\\"' to src/debounce.test.ts"
Decision: ADD
{
  "op":"ADD","kind":"gotcha","importance":0.7,
  "title":"bun:test requires explicit timer imports",
  "body":"bun:test does NOT auto-inject setTimeout/setInterval globals like vitest does. Test files must 'import { setTimeout } from \\"node:timers\\"' explicitly. Discovered on 2026-04-20 when src/debounce.test.ts failed after vitest→bun:test migration.\\n\\nRefs:\\n- src/debounce.test.ts",
  "tags":["bun","testing","migration"],
  "links":[]
}

### Example 2 — ADD (decision, captures transition)
User intent: "vamos usar MSW pros tests da API?"
Events: "installed msw@2", "wrote src/mocks/handlers.ts"
Decision: ADD
{
  "op":"ADD","kind":"decision","importance":0.8,
  "title":"MSW v2 for API test mocking",
  "body":"Chose MSW v2 over vi.fn/jest.fn mocks for API integration tests because MSW tests the full fetch pipeline including headers, status codes, and error paths. Decided on 2026-04-20. Handlers colocated in src/mocks/handlers.ts, imported per test file.\\n\\nRefs:\\n- src/mocks/handlers.ts\\n- package.json",
  "tags":["testing","mocking","api"],
  "links":["JWT auth decision"]
}

### Example 3 — NOOP (honest, routine)
Events: "ran ls src/", "read src/util.ts", "ran grep 'debounce' src/"
Decision: NOOP
{"op":"NOOP","reason":"routine exploration with no decisions, gotchas, or surprising findings"}

### Example 4 — UPDATE (delta on existing decision)
Candidates: "cand_0: JWT auth 15min+7d refresh"
Events: "edited src/auth/config.ts", "refresh token extended from 7d to 30d per user feedback"
Decision: UPDATE
{
  "op":"UPDATE","targetId":"cand_0","kind":"decision","importance":0.7,
  "title":"JWT auth 15min+30d refresh",
  "body":"JWT auth: 15min access + 30d refresh (extended from 7d on 2026-04-20 after user feedback about re-login friction). Tokens in httpOnly cookies. src/auth/config.ts.\\n\\nRefs:\\n- src/auth/config.ts",
  "tags":["auth","jwt"],
  "links":[]
}

## OUTPUT FORMAT (strict JSON, no markdown fences, no prose outside JSON)

{
  "op": "ADD" | "UPDATE" | "DELETE" | "NOOP",
  "reason": "one-line why",
  "targetId": "cand_0" (only UPDATE/DELETE),
  "kind": "fact" | "decision" | "gotcha" | "skill" | "episode" | "convention",
  "title": "short descriptive title",
  "body": "markdown body 5-40 lines with specifics and dates. End with 'Refs:' section listing relevant file paths. No 'Related:' section — links are via links field.",
  "tags": ["tag1","tag2"],
  "links": ["exact title from 'All vault titles' list"],
  "supersedes": "candidate title" (DELETE only, optional),
  "importance": 0.1-1.0,
  "confidence_tier": "extracted" | "inferred" | "ambiguous" (optional),
  "confidence_score": 0.0-1.0 (optional)
}

When op=NOOP, only "op" and "reason" are required.

Importance: 0.1 trivial | 0.5 useful context | 0.7 notable decision/gotcha | 0.9 critical gotcha.

Confidence tier (optional — omit if uncertain):
- "extracted": user explicitly stated the fact ("we use JWT", "decided to pick X")
- "inferred": deduced from tool events without explicit user statement
- "ambiguous": reasonable guess from weak signals; flag for review

Confidence score (optional — include when tier is set):
- 0.9: strong direct evidence (user stated it, commit message confirms it)
- 0.6: moderate evidence (consistent tool output + context)
- 0.3: weak signal (single ambiguous event, indirect reference)

CRITICAL: "links" field must ONLY contain EXACT titles from the "All vault titles" list provided in the user message. Do NOT invent titles. If vault is empty, "links" MUST be [].`

function buildGateUserMessage(
  batch: CaptureEventInput[],
  userPrompt: string | undefined,
  candidates: Array<{ id: string; title: string; description: string; tags: string[] }>,
  allVaultTitles: string[] = [],
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

  // Provide the complete list of vault note titles so the LLM can create
  // valid links to ANY existing note, not just the top-K candidates.
  if (allVaultTitles.length > 0) {
    parts.push(`All vault titles (${allVaultTitles.length}) — use these EXACT titles for the "links" field:`)
    for (const title of allVaultTitles) {
      parts.push(`- "${title}"`)
    }
    parts.push("")
  } else {
    parts.push("All vault titles: (none — vault is empty, set links to [])")
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
  confidence_tier?: Confidence
  confidence_score?: number
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
      confidence_tier: coerceConfidence(parsed.confidence_tier),
      confidence_score:
        typeof parsed.confidence_score === "number"
          ? Math.max(0, Math.min(1, parsed.confidence_score))
          : undefined,
    }
  } catch {
    return null
  }
}

// Exposed for testing
export const __internal = {
  isTrivial,
  isFilterable,
  normalizeHash,
  buildGateUserMessage,
  extractCommitMeta,
  DEBOUNCE_MS,
  CIRCUIT_FAIL_THRESHOLD,
  CIRCUIT_PAUSE_MS,
}
