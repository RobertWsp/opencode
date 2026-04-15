import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../../util/log"
import * as Commands from "./commands"
import { formatBlock } from "./injector"
import { detectScope } from "./scope"
import type { MemoryConfig, Scope } from "./types"
import { fingerprint, loadAll } from "./vault"

const log = Log.create({ service: "plugin.obsidian-memory" })

const CACHE_TTL_MS = 30_000
const DEFAULT_MAX_BYTES = 4096
const DEFAULT_MAX_NOTES = 20

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

/**
 * obsidian-memory plugin.
 *
 * Hooks:
 * - `config`: registers the `/memory` slash command when enabled
 * - `experimental.chat.system.transform`: injects the memory block into
 *   the system prompt, in a form that is idempotent and cache-friendly
 */
export async function ObsidianMemoryPlugin(input: PluginInput): Promise<Hooks> {
  log.info("loading plugin", { phase: "F2" })

  // Per-scope cache, keyed by `repoSlug::branchSlug`.
  const cache = new Map<string, CacheEntry>()
  let cfgRef: MemoryConfig | undefined

  const resolveScope = async (): Promise<Scope | null> => {
    if (!cfgRef?.enabled) return null
    const scope = await detectScope({
      worktree: input.worktree,
      vaultPath: cfgRef.vaultPath,
    })
    return scope
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
      }
      anyCfg.command ??= {}
      if (!anyCfg.command["memory"]) {
        anyCfg.command["memory"] = {
          description: "Obsidian memory ops (save|list|show)",
          template: "memory $ARGUMENTS",
        }
        log.info("registered /memory command")
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
        else result = { ok: false, text: `[memory] unknown verb "${verb}". use save|list|show` }
      } catch (err) {
        result = { ok: false, text: `[memory] error: ${err instanceof Error ? err.message : String(err)}` }
      }
      replaceParts(hookOutput, result.text)
      log.info("command executed", { verb, ok: result.ok, bytes: result.text.length })
    },

    async "experimental.chat.system.transform"(hookInput, hookOutput) {
      if (!cfgRef?.enabled) return
      if (hookInput.model?.providerID !== "anthropic") return

      const scope = await resolveScope()
      if (!scope) {
        log.debug("scope detection failed — skipping injection")
        return
      }

      const cacheKey = `${scope.repoSlug}::${scope.branchSlug}`
      const fp = await fingerprint(scope)
      const cached = cache.get(cacheKey)
      const now = Date.now()

      let block: string
      if (cached && cached.fingerprint === fp && now - cached.ts < CACHE_TTL_MS) {
        block = cached.block
      } else {
        const docs = await loadAll(scope, cfgRef.maxNotes)
        block = formatBlock(scope, docs, { maxBytes: cfgRef.maxBytes })
        cache.set(cacheKey, { fingerprint: fp, block, ts: now })
      }

      if (!block) return
      hookOutput.system.push(block)
      log.info("memory injected", {
        scope: cacheKey,
        bytes: block.length,
        fingerprint: fp.slice(0, 8),
      })
    },
  }
}
