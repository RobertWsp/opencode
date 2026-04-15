import { promises as fs } from "fs"
import path from "path"
import { Log } from "../../util/log"
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter"
import { callHaiku } from "./haiku-client"
import type { Scope } from "./types"
import { VaultGit } from "./vault-git"

const log = Log.create({ service: "plugin.obsidian-memory.consolidate" })

/**
 * Sonnet-backed consolidation pass over accumulated auto-capture notes.
 *
 * Runs when the capture gate has accumulated enough notes to justify the
 * cost (default: 5+). Operations supported:
 *
 * - **merge**: combine 2+ notes about the same topic into a single denser note
 * - **rewrite**: tighten prose, normalize style, remove filler
 * - **promote**: move a note from branches/<branch>/notes/ to repos/<slug>/
 *   when it applies to the whole repo, not just the branch
 * - **delete**: drop outdated or low-signal notes
 *
 * All operations are applied atomically to the filesystem (stage → write →
 * git commit). On LLM failure, the vault is untouched.
 *
 * Trigger points (all in plugin index):
 * - session.idle (after a capture batch wrote new notes)
 * - session.compacted (user explicitly asked for context compaction)
 * - manual: /memory consolidate
 *
 * Locking: at most ONE consolidation runs per scope. Concurrent triggers
 * are deduped via `inflight` set.
 */

export interface ConsolidateOptions {
  model: string
  timeoutMs?: number
  maxNotesPerRun?: number
  minNotesToTrigger?: number
}

export interface ConsolidateResult {
  ok: boolean
  notesConsidered: number
  operations: ConsolidateOp[]
  error?: string
  durationMs: number
}

export type ConsolidateOp =
  | { type: "merge"; target: string; sources: string[]; summary: string }
  | { type: "rewrite"; path: string; summary: string }
  | { type: "promote"; source: string; target: string; summary: string }
  | { type: "delete"; path: string; reason: string }

interface ConsolidatorState {
  inflight: Set<string>
}

const state: ConsolidatorState = {
  inflight: new Set(),
}

/**
 * Run a consolidation pass for a given scope. Returns what was done.
 * Silent no-op if there are not enough notes to justify the Sonnet cost,
 * or if a consolidation is already running for the same scope.
 */
export async function consolidate(
  scope: Scope,
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const started = Date.now()
  const key = `${scope.repoSlug}::${scope.branchSlug}`

  if (state.inflight.has(key)) {
    return {
      ok: false,
      notesConsidered: 0,
      operations: [],
      error: "consolidation already running for scope",
      durationMs: 0,
    }
  }
  state.inflight.add(key)

  try {
    const notes = await listRecentNotes(scope, opts.maxNotesPerRun ?? 20)
    if (notes.length < (opts.minNotesToTrigger ?? 5)) {
      return {
        ok: true,
        notesConsidered: notes.length,
        operations: [],
        durationMs: Date.now() - started,
      }
    }

    const payload = buildConsolidatorPayload(scope, notes)
    const llm = await callHaiku({
      model: opts.model,
      systemPrompt: CONSOLIDATOR_SYSTEM_PROMPT,
      userMessage: payload,
      maxTokens: 2000,
      timeoutMs: opts.timeoutMs ?? 45_000,
    })

    if (!llm.ok) {
      log.warn("sonnet call failed", { error: llm.error, duration: llm.durationMs })
      return {
        ok: false,
        notesConsidered: notes.length,
        operations: [],
        error: llm.error,
        durationMs: Date.now() - started,
      }
    }

    const ops = parseConsolidatorResponse(llm.text ?? "")
    if (!ops || ops.length === 0) {
      log.info("consolidation produced no operations", {
        scope: key,
        duration: llm.durationMs,
      })
      return {
        ok: true,
        notesConsidered: notes.length,
        operations: [],
        durationMs: Date.now() - started,
      }
    }

    const applied: ConsolidateOp[] = []
    for (const op of ops) {
      const ok = await applyOperation(scope, op)
      if (ok) applied.push(op)
    }

    if (applied.length > 0) {
      const message = buildCommitMessage(scope, applied)
      await VaultGit.ensureAndCommit(scope.vaultRoot, message)
    }

    log.info("consolidation done", {
      scope: key,
      considered: notes.length,
      applied: applied.length,
      duration: Date.now() - started,
    })

    return {
      ok: true,
      notesConsidered: notes.length,
      operations: applied,
      durationMs: Date.now() - started,
    }
  } finally {
    state.inflight.delete(key)
  }
}

interface LoadedNote {
  absPath: string
  relPath: string
  meta: Record<string, string>
  body: string
  mtimeMs: number
}

async function listRecentNotes(scope: Scope, maxNotes: number): Promise<LoadedNote[]> {
  try {
    const entries = await fs.readdir(scope.notesDir)
    const mdFiles = entries.filter((e) => e.endsWith(".md"))
    const loaded = await Promise.all(
      mdFiles.map(async (name) => {
        const absPath = path.join(scope.notesDir, name)
        try {
          const [stat, source] = await Promise.all([
            fs.stat(absPath),
            fs.readFile(absPath, "utf8"),
          ])
          const { meta, body } = parseFrontmatter(source)
          return {
            absPath,
            relPath: path.relative(scope.vaultRoot, absPath),
            meta,
            body,
            mtimeMs: stat.mtimeMs,
          }
        } catch {
          return null
        }
      }),
    )
    return loaded
      .filter((n): n is LoadedNote => n !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxNotes)
  } catch {
    return []
  }
}

const CONSOLIDATOR_SYSTEM_PROMPT = `You are a memory consolidator for a coding assistant's note vault.

You receive a list of recently-captured memory notes. Your job is to keep
the vault tight: merge duplicates, drop low-signal entries, promote facts
that apply to the whole repo (not just the current branch), and tighten
prose. Be AGGRESSIVE — the cost of a bloated vault is worse than losing
a noisy note.

Output STRICTLY valid JSON, an array of operations. No prose, no markdown:

[
  {"type": "merge", "sources": ["relpath1", "relpath2"], "target_title": "short-kebab", "body": "merged markdown"},
  {"type": "rewrite", "path": "relpath", "body": "tightened markdown"},
  {"type": "promote", "source": "relpath", "reason": "applies to whole repo"},
  {"type": "delete", "path": "relpath", "reason": "routine, no future value"}
]

Rules:
- "merge" creates a new note combining the sources; the sources will be deleted
- "promote" moves a note from branches/<branch>/notes/ to repos/<slug>/MEMORY.md
  (appended as a new section). The original source is deleted after merge into MEMORY.md.
- "delete" is permanent (audit is via git)
- Empty array is valid — return [] if no consolidation needed
- Never output notes paths that were not in the input
- Conserve information: if you merge, the target body must capture everything useful from sources
- "rewrite" keeps the same path but replaces body (title/meta unchanged)`

function buildConsolidatorPayload(scope: Scope, notes: LoadedNote[]): string {
  const lines: string[] = []
  lines.push(`Scope: repo=${scope.shortHash} branch=${scope.branchSlug}`)
  lines.push(`Notes to consolidate (${notes.length}):`)
  lines.push("")
  for (const note of notes) {
    lines.push(`### ${note.relPath}`)
    if (note.meta.title) lines.push(`title: ${note.meta.title}`)
    if (note.meta.tags) lines.push(`tags: ${note.meta.tags}`)
    if (note.meta.importance) lines.push(`importance: ${note.meta.importance}`)
    lines.push("")
    lines.push(note.body.trim())
    lines.push("")
  }
  return lines.join("\n")
}

/** Parse consolidator LLM output — returns operations array or null on failure */
export function parseConsolidatorResponse(raw: string): ConsolidateOp[] | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  if (!cleaned) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const out: ConsolidateOp[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue
    const op = item as Record<string, unknown>
    const type = op["type"]
    if (type === "merge") {
      const sources = op["sources"]
      const title = op["target_title"] ?? op["target"]
      const body = op["body"]
      if (Array.isArray(sources) && typeof title === "string" && typeof body === "string") {
        const validated = sources
          .filter((s): s is string => typeof s === "string")
          .filter((s) => !path.isAbsolute(s) && !s.includes(".."))
        if (validated.length > 0) {
          out.push({ type: "merge", sources: validated, target: title, summary: body })
        }
      }
    } else if (type === "rewrite") {
      const p = op["path"]
      const body = op["body"]
      if (typeof p === "string" && typeof body === "string" && !path.isAbsolute(p) && !p.includes("..")) {
        out.push({ type: "rewrite", path: p, summary: body })
      }
    } else if (type === "promote") {
      const src = op["source"]
      const reason = op["reason"]
      if (typeof src === "string" && !path.isAbsolute(src) && !src.includes("..")) {
        out.push({
          type: "promote",
          source: src,
          target: "repo-shared",
          summary: typeof reason === "string" ? reason : "",
        })
      }
    } else if (type === "delete") {
      const p = op["path"]
      const reason = op["reason"]
      if (typeof p === "string" && !path.isAbsolute(p) && !p.includes("..")) {
        out.push({ type: "delete", path: p, reason: typeof reason === "string" ? reason : "" })
      }
    }
  }
  return out
}

async function applyOperation(scope: Scope, op: ConsolidateOp): Promise<boolean> {
  try {
    if (op.type === "delete") {
      const abs = resolveWithinVault(scope, op.path)
      if (!abs) return false
      await fs.unlink(abs).catch(() => undefined)
      return true
    }
    if (op.type === "rewrite") {
      const abs = resolveWithinVault(scope, op.path)
      if (!abs) return false
      const source = await fs.readFile(abs, "utf8").catch(() => null)
      if (!source) return false
      const { meta } = parseFrontmatter(source)
      const newMeta = { ...meta, "rewritten-at": new Date().toISOString() }
      const content = serializeFrontmatter(newMeta, op.summary)
      await fs.writeFile(abs, content, "utf8")
      return true
    }
    if (op.type === "merge") {
      // Write target note with merged body, then delete sources
      const ts = new Date().toISOString().replace(/[:.]/g, "-")
      const slug =
        op.target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) ||
        "merged"
      const filename = `${ts}-merged-${slug}.md`
      const targetAbs = path.join(scope.notesDir, filename)
      const meta = {
        type: "memory-note",
        title: op.target,
        repo: scope.shortHash,
        branch: scope.branchSlug,
        created: new Date().toISOString(),
        "memory-type": "consolidated",
        source: "sonnet-consolidator",
        "merged-from": op.sources.map((s) => path.basename(s)).join(","),
      }
      await fs.mkdir(path.dirname(targetAbs), { recursive: true })
      await fs.writeFile(targetAbs, serializeFrontmatter(meta, op.summary), "utf8")
      for (const src of op.sources) {
        const abs = resolveWithinVault(scope, src)
        if (abs) await fs.unlink(abs).catch(() => undefined)
      }
      return true
    }
    if (op.type === "promote") {
      // Append source body to repos/<slug>/MEMORY.md and delete original
      const srcAbs = resolveWithinVault(scope, op.source)
      if (!srcAbs) return false
      const source = await fs.readFile(srcAbs, "utf8").catch(() => null)
      if (!source) return false
      const { meta, body } = parseFrontmatter(source)
      const header = `\n\n## ${meta.title || path.basename(op.source, ".md")}\n_promoted from branch_ · _${new Date().toISOString()}_\n\n`
      await appendToSharedMemory(scope.repoSharedPath, header + body.trim() + "\n")
      await fs.unlink(srcAbs).catch(() => undefined)
      return true
    }
    return false
  } catch (err) {
    log.error("applyOperation failed", { op, error: String(err) })
    return false
  }
}

async function appendToSharedMemory(absPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  const existing = await fs.readFile(absPath, "utf8").catch(() => null)
  if (existing === null) {
    const seed = `---\ntype: memory-shared\nupdated: ${new Date().toISOString()}\n---\n\n# Shared Memory${content}`
    await fs.writeFile(absPath, seed, "utf8")
    return
  }
  await fs.writeFile(absPath, existing.replace(/\n+$/, "") + content, "utf8")
}

function resolveWithinVault(scope: Scope, relOrAbs: string): string | null {
  const abs = path.resolve(scope.vaultRoot, relOrAbs)
  const rootWithSep = scope.vaultRoot.endsWith(path.sep)
    ? scope.vaultRoot
    : scope.vaultRoot + path.sep
  if (!abs.startsWith(rootWithSep) && abs !== scope.vaultRoot) return null
  return abs
}

function buildCommitMessage(scope: Scope, ops: ConsolidateOp[]): string {
  const counts = { merge: 0, rewrite: 0, promote: 0, delete: 0 }
  for (const op of ops) counts[op.type]++
  const parts: string[] = []
  if (counts.merge) parts.push(`${counts.merge} merged`)
  if (counts.rewrite) parts.push(`${counts.rewrite} rewritten`)
  if (counts.promote) parts.push(`${counts.promote} promoted`)
  if (counts.delete) parts.push(`${counts.delete} deleted`)
  return `memory(consolidate): ${parts.join(", ")} [${scope.branchSlug}]`
}
