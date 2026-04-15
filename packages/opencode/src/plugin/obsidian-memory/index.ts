import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../../util/log"
import { CaptureGate, type CaptureEventInput } from "./capture-gate"
import * as Commands from "./commands"
import { formatBlock, type RefHealthMap } from "./injector"
import { logEntry } from "./injection-log"
import { verifyDocRefs } from "./refs"
import { detectGitEvent, toCaptureEvent } from "./git-event-detector"
import { computePageRank, seedsFromPrompt } from "./pagerank"
import { noteSessionIdle, runReflection } from "./reflection-scheduler"
import { expandQueryHyde, rankMemories } from "./retrieval"
import { detectScope } from "./scope"
import type { MemoryConfig, Scope, VaultDocs } from "./types"
import { fingerprint, loadAll } from "./vault"

const log = Log.create({ service: "plugin.obsidian-memory" })

const CACHE_TTL_MS = 30_000
const DEFAULT_MAX_BYTES = 4096
const DEFAULT_MAX_NOTES = 20
const DEFAULT_CAPTURE_MODEL = "claude-haiku-4-5-20251001"
const DEFAULT_CONSOLIDATE_MODEL = "claude-sonnet-4-5-20250929"

interface CacheEntry {
  fingerprint: string
  block: string
  ts: number
}

/**
 * Replace `output.parts` with a single text part. Used by `command.execute.before`
 * to return canned output to the user instead of the template placeholder.
 */
function replaceParts(output: { parts: Array<{ type: string; text?: string }> }, text: string): void {
  output.parts.length = 0
  output.parts.push({ type: "text", text })
}

/** Deterministic short hash used only as a cache key segment. */
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * When smart retrieval is enabled, rank the notes by the composed scorer
 * (optionally with HyDE expansion) and return a new VaultDocs with the
 * notes array reordered. Shared memories (system/repo/branch) always stay
 * because they are scope-level by definition.
 */
async function maybeRank(
  scope: Scope,
  userPrompt: string,
  docs: VaultDocs,
  cfg: MemoryConfig,
): Promise<VaultDocs> {
  if (!cfg.smartRetrieval || docs.notes.length === 0) return docs
  const query = cfg.hydeExpansion
    ? await expandQueryHyde(userPrompt, cfg.captureModel).catch(() => userPrompt)
    : userPrompt
  if (!query.trim()) return docs
  try {
    // Compute PageRank scores for graph-aware ranking
    const pageRankResult = await computePageRank(scope, {
      queryTokens: seedsFromPrompt(query),
    }).catch(() => null)
    const pagerankScores = pageRankResult?.scores

    const ranked = await rankMemories(scope, query, {
      limit: cfg.maxNotes,
      useFts5: true,
      pagerankScores,
    })
    // Preserve ordering relative to the ranked list but keep only notes
    // that were in the original `notes` array (shared docs are untouched).
    const notesByPath = new Map(docs.notes.map((n) => [n.path, n]))
    const reordered = ranked
      .map((r) => notesByPath.get(r.entry.doc.path))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
    // Fallback: include any note that did not appear in ranked (rare — when
    // the index is out of sync)
    for (const note of docs.notes) {
      if (!ranked.some((r) => r.entry.doc.path === note.path)) reordered.push(note)
    }
    return { ...docs, notes: reordered }
  } catch (err) {
    log.debug("smart retrieval failed, falling back to mtime", { error: String(err) })
    return docs
  }
}

/**
 * Verify refs for every doc that is a candidate for injection.
 * Returns a map keyed by doc path → health snapshot.
 */
async function buildRefHealthMap(
  worktree: string,
  docs: import("./types").VaultDocs,
): Promise<RefHealthMap> {
  const out: RefHealthMap = new Map()
  const targets: import("./types").MemoryDoc[] = []
  if (docs.systemShared) targets.push(docs.systemShared)
  if (docs.repoShared) targets.push(docs.repoShared)
  if (docs.branchShared) targets.push(docs.branchShared)
  for (const note of docs.notes) targets.push(note)
  await Promise.all(
    targets.map(async (doc) => {
      const health = await verifyDocRefs(worktree, doc)
      out.set(doc.path, health)
    }),
  )
  return out
}

/**
 * obsidian-memory plugin.
 *
 * Hooks registered (enabled by config.memory.enabled):
 * - `config`: registers the `/memory` slash command + caches config
 * - `command.execute.before`: handles /memory save|list|show
 * - `experimental.chat.system.transform`: injects memory block into system prompt
 * - `chat.message`: feeds user prompt to capture gate for context
 * - `tool.execute.after`: feeds tool outcomes to capture gate
 * - `event`: drives session.idle flush + session.deleted cleanup
 */
export async function ObsidianMemoryPlugin(input: PluginInput): Promise<Hooks> {
  log.info("loading plugin")

  // Per-scope cache, keyed by `repoSlug::branchSlug::queryHash`.
  const cache = new Map<string, CacheEntry>()
  let cfgRef: MemoryConfig | undefined
  let captureGate: CaptureGate | undefined
  // Remember last user prompt per session so injection can use it for ranking.
  const lastPrompt = new Map<string, string>()

  const resolveScope = async (): Promise<Scope | null> => {
    if (!cfgRef?.enabled) return null
    return detectScope({ worktree: input.worktree, vaultPath: cfgRef.vaultPath })
  }

  return {
    async config(cfg) {
      const anyCfg = cfg as unknown as {
        memory?: Partial<MemoryConfig>
        command?: Record<string, { description?: string; template: string | Promise<string> }>
      }
      if (!anyCfg.memory?.enabled) {
        log.debug("memory disabled in config — plugin is a no-op")
        cfgRef = undefined
        return
      }
      cfgRef = {
        enabled: true,
        vaultPath: anyCfg.memory.vaultPath,
        maxBytes: anyCfg.memory.maxBytes ?? DEFAULT_MAX_BYTES,
        maxNotes: anyCfg.memory.maxNotes ?? DEFAULT_MAX_NOTES,
        autoCapture: anyCfg.memory.autoCapture ?? false,
        captureModel: anyCfg.memory.captureModel ?? DEFAULT_CAPTURE_MODEL,
        autoConsolidate: anyCfg.memory.autoConsolidate ?? false,
        consolidateModel: anyCfg.memory.consolidateModel ?? DEFAULT_CONSOLIDATE_MODEL,
        injectionStyle: anyCfg.memory.injectionStyle ?? "full",
        smartRetrieval: anyCfg.memory.smartRetrieval ?? false,
        hydeExpansion: anyCfg.memory.hydeExpansion ?? false,
        suggestThreshold: anyCfg.memory.suggestThreshold ?? 0,
      }
      anyCfg.command ??= {}
      if (!anyCfg.command["memory"]) {
        anyCfg.command["memory"] = {
          description: "Obsidian memory ops (save|list|show)",
          template: "memory $ARGUMENTS",
        }
        log.info("registered /memory command")
      }
      if (cfgRef.autoCapture) {
        captureGate = new CaptureGate({
          enabled: true,
          model: cfgRef.captureModel,
          suggestThreshold: cfgRef.suggestThreshold,
          scopeResolver: async () => resolveScope(),
        })
        log.info("auto-capture enabled", {
          model: cfgRef.captureModel,
          suggestThreshold: cfgRef.suggestThreshold,
        })
      }
    },

    async "command.execute.before"(hookInput, hookOutput) {
      if (hookInput.command !== "memory") return
      if (!cfgRef?.enabled) {
        replaceParts(hookOutput, "[memory] plugin disabled in config")
        return
      }
      const scope = await resolveScope()
      if (!scope) {
        replaceParts(hookOutput, "[memory] vault not configured or git repo not detected")
        return
      }
      // opencode run --command escapes args with spaces as literal quoted strings
      // (see packages/opencode/src/cli/cmd/run.ts:313). Strip matching outer quotes
      // before parsing so `"save foo"` and `save foo` behave the same.
      let raw = (hookInput.arguments ?? "").trim()
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        raw = raw.slice(1, -1).replace(/\\"/g, '"')
      }
      const space = raw.indexOf(" ")
      const verb = (space >= 0 ? raw.slice(0, space) : raw).toLowerCase() || "list"
      const rest = space >= 0 ? raw.slice(space + 1).trim() : ""

      let result: { ok: boolean; text: string }
      try {
        if (verb === "save") result = await Commands.save(scope, rest, hookInput.sessionID, input.client)
        else if (verb === "list") result = await Commands.list(scope)
        else if (verb === "show") result = await Commands.show(scope, rest)
        else if (verb === "stats") result = await Commands.stats(scope)
        else if (verb === "suggested") result = await Commands.suggested(scope)
        else if (verb === "approve") result = await Commands.approve(scope, rest)
        else if (verb === "reject") result = await Commands.reject(scope, rest)
        else
          result = {
            ok: false,
            text: `[memory] unknown verb "${verb}". use save|list|show|stats|suggested|approve|reject`,
          }
      } catch (err) {
        result = { ok: false, text: `[memory] error: ${err instanceof Error ? err.message : String(err)}` }
      }
      replaceParts(hookOutput, result.text)
      log.info("command executed", { verb, ok: result.ok, bytes: result.text.length })
      logEntry({
        kind: "command",
        ts: Date.now(),
        sessionID: hookInput.sessionID,
        verb,
        ok: result.ok,
      }).catch(() => undefined)
    },

    async "experimental.chat.system.transform"(hookInput, hookOutput) {
      if (!cfgRef?.enabled) return
      if (hookInput.model?.providerID !== "anthropic") return

      const scope = await resolveScope()
      if (!scope) {
        log.debug("scope detection failed — skipping injection")
        return
      }

      const userPrompt = hookInput.sessionID ? lastPrompt.get(hookInput.sessionID) ?? "" : ""
      const queryHash = userPrompt ? shortHash(userPrompt) : "none"
      const cacheKey = `${scope.repoSlug}::${scope.branchSlug}::${queryHash}`
      const fp = await fingerprint(scope)
      const cached = cache.get(cacheKey)
      const now = Date.now()

      let block: string
      let wasCached = false
      if (cached && cached.fingerprint === fp && now - cached.ts < CACHE_TTL_MS) {
        block = cached.block
        wasCached = true
      } else {
        const docs = await loadAll(scope, cfgRef.maxNotes)
        const rankedDocs = await maybeRank(scope, userPrompt, docs, cfgRef)
        const refHealth = await buildRefHealthMap(input.worktree, rankedDocs)
        block = formatBlock(
          scope,
          rankedDocs,
          { maxBytes: cfgRef.maxBytes },
          refHealth,
          cfgRef.injectionStyle,
        )
        cache.set(cacheKey, { fingerprint: fp, block, ts: now })
      }

      if (!block) return
      hookOutput.system.push(block)
      log.info("memory injected", {
        scope: `${scope.repoSlug}::${scope.branchSlug}`,
        bytes: block.length,
        fingerprint: fp.slice(0, 8),
        smart: cfgRef.smartRetrieval,
        hyde: cfgRef.hydeExpansion,
      })
      logEntry({
        kind: "inject",
        ts: Date.now(),
        sessionID: hookInput.sessionID ?? "",
        scope: `${scope.repoSlug}::${scope.branchSlug}`,
        bytes: block.length,
        fingerprint: fp.slice(0, 8),
        cached: wasCached,
        style: cfgRef.injectionStyle,
      }).catch(() => undefined)
    },

    async "chat.message"(hookInput, hookOutput) {
      const parts = (hookOutput as unknown as { parts?: Array<{ type: string; text?: string }> }).parts
      const promptText = (parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim()
      if (!promptText) return
      // Remember for the next system-prompt-transform call so retrieval
      // can score against the user's actual question.
      lastPrompt.set(hookInput.sessionID, promptText)
      if (captureGate) captureGate.noteUserPrompt(hookInput.sessionID, promptText)
    },

    async "tool.execute.after"(hookInput, hookOutput) {
      if (!captureGate) return
      if (!hookOutput) return
      const summary = typeof hookOutput.title === "string" ? hookOutput.title : hookInput.tool
      const ev: CaptureEventInput = {
        kind: "tool.after",
        sessionID: hookInput.sessionID,
        summary: summary.slice(0, 200),
        details: {
          tool: hookInput.tool,
          callID: hookInput.callID,
        },
        timestamp: Date.now(),
      }
      captureGate.enqueue(ev)

      // Git event enrichment: when the agent runs `git <subcommand>` via
      // bash, surface it as an additional high-signal capture event so
      // the Haiku gate can decide whether it deserves a timeline memory.
      if (hookInput.tool === "bash") {
        const args = (hookInput as unknown as { args?: { command?: string } }).args
        const command = args?.command
        if (typeof command === "string") {
          const candidate = detectGitEvent(
            command,
            typeof hookOutput.output === "string" ? hookOutput.output : undefined,
          )
          if (candidate) {
            captureGate.enqueue(toCaptureEvent(candidate, hookInput.sessionID))
          }
        }
      }
    },

    async event({ event }: { event: { type: string; properties?: unknown } }) {
      if (!captureGate) return
      if (event.type === "session.idle") {
        const props = event.properties as { sessionID?: string } | undefined
        if (props?.sessionID) {
          await captureGate.flush(props.sessionID).catch(() => undefined)
          // Chain consolidation after the flush — if auto-consolidate is on
          // and we just wrote notes, Sonnet decides what to do with them.
          if (cfgRef?.autoConsolidate) {
            const scope = await resolveScope()
            if (scope) {
              // Track session idle for the reflection gate
              noteSessionIdle(scope)
              // Run reflection in an isolated git worktree (when gate opens)
              runReflection(scope, {
                model: cfgRef.consolidateModel,
                minHoursSinceLast: 24,
                minSessionsSinceLast: 5,
                minNotesToTrigger: 5,
                maxNotesPerRun: 20,
              }).catch((err) => log.warn("reflection failed", { error: String(err) }))
            }
          }
        }
      } else if (event.type === "session.deleted" || event.type === "session.compacted") {
        const props = event.properties as
          | { sessionID?: string; info?: { id?: string } }
          | undefined
        const sessionID = props?.sessionID ?? props?.info?.id
        if (sessionID) captureGate.forget(sessionID)
      } else if (event.type === "session.error") {
        const props = event.properties as
          | { sessionID?: string; error?: { message?: string } }
          | undefined
        if (props?.sessionID) {
          const msg = props.error?.message ?? "session.error"
          captureGate.enqueue({
            kind: "session.error",
            sessionID: props.sessionID,
            summary: msg.slice(0, 200),
            timestamp: Date.now(),
          })
        }
      }
    },
  }
}
