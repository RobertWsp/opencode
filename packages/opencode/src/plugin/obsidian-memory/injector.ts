import { createHash } from "crypto"
import path from "path"
import { isValidAt, toEntry } from "./parse-entry"
import type { DocRefHealth } from "./refs"
import type { InjectorOptions, MemoryDoc, Scope, VaultDocs } from "./types"

/**
 * True if the doc should be excluded from injection because it has been
 * invalidated (bitemporal soft-delete via valid_until).
 */
function isInvalidated(doc: MemoryDoc | undefined): boolean {
  if (!doc) return false
  return !isValidAt(toEntry(doc))
}

/**
 * Map of doc path → ref health, supplied by the caller. When provided,
 * the injector will skip docs whose refs are ALL broken and prepend a
 * `<stale>` marker to docs with ANY broken ref.
 */
export type RefHealthMap = Map<string, DocRefHealth>

/** Injection format flavor */
export type InjectionStyle = "full" | "index"

/**
 * Format a deterministic `<memory-block>` string suitable for injection into
 * the system prompt.
 *
 * Properties guaranteed for cache-friendliness:
 * - Byte-identical output for identical inputs (no timestamps/random)
 * - No literal "opencode" or "OpenCode" strings (anthropic plugin rewrites
 *   these before sending; we use shortHash in the wrapper instead)
 * - Truncation drops oldest notes first when body > maxBytes
 * - `hash` attribute is sha256 of the body (truncated), used for cache keys
 *
 * Returns an empty string when the vault has no content to inject.
 */
export function formatBlock(
  scope: Scope,
  docs: VaultDocs,
  opts: InjectorOptions,
  refHealth?: RefHealthMap,
  style: InjectionStyle = "full",
): string {
  if (style === "index") return formatIndexBlock(scope, docs, opts, refHealth)
  const sections: string[] = []

  const renderShared = (doc: MemoryDoc | undefined): string | null => {
    if (!doc || !doc.body.trim()) return null
    if (isInvalidated(doc)) return null
    const health = refHealth?.get(doc.path)
    if (health?.allBroken) return null
    const prefix = health && health.brokenCount > 0 ? "<stale-refs>\n" : ""
    const suffix = health && health.brokenCount > 0 ? "\n</stale-refs>" : ""
    return prefix + doc.body.trim() + suffix
  }

  // System layer (user preferences, feedback) always goes first
  const systemBody = renderShared(docs.systemShared)
  if (systemBody) sections.push("## User Preferences\n" + systemBody)

  const repoBody = renderShared(docs.repoShared)
  if (repoBody) sections.push("## Shared (repo)\n" + repoBody)

  const branchBody = renderShared(docs.branchShared)
  if (branchBody) sections.push(`## Shared (branch: ${scope.branchSlug})\n${branchBody}`)

  // Drop notes whose refs are all broken OR have been invalidated
  const validNotes = docs.notes.filter((n) => {
    if (isInvalidated(n)) return false
    const health = refHealth?.get(n.path)
    return !health?.allBroken
  })

  const notesToRender = truncateNotes(validNotes, sectionBytes(sections), opts.maxBytes)
  if (notesToRender.length > 0) {
    const noteLines = ["## Recent Notes"]
    for (const note of notesToRender) {
      const title = note.meta.title || stripExtension(basenameFromPath(note.path))
      const when = note.meta.created || ""
      const heading = when ? `### ${when} — ${title}` : `### ${title}`
      const health = refHealth?.get(note.path)
      const isStale = health && health.brokenCount > 0
      if (isStale) {
        noteLines.push(heading, "<stale-refs>", note.body.trim(), "</stale-refs>")
      } else {
        noteLines.push(heading, note.body.trim())
      }
    }
    sections.push(noteLines.join("\n"))
  }

  if (sections.length === 0) return ""

  const body = sections.join("\n\n")
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8)
  return [
    `<memory-block repo="${scope.shortHash}" branch="${scope.branchSlug}" hash="${hash}">`,
    body,
    `</memory-block>`,
  ].join("\n")
}

/**
 * Greedy truncation: include newest notes first until the cumulative budget
 * is exhausted. Returns a new array, does not mutate.
 *
 * Budget is calculated as maxBytes minus the already-rendered shared sections.
 * If even one note does not fit, returns an empty array.
 */
function truncateNotes(notes: MemoryDoc[], usedBytes: number, maxBytes: number): MemoryDoc[] {
  const budget = maxBytes - usedBytes - 200 // 200 bytes reserve for wrapper+heading
  if (budget <= 0) return []
  const result: MemoryDoc[] = []
  let running = 0
  for (const note of notes) {
    const title = note.meta.title || stripExtension(basenameFromPath(note.path))
    const when = note.meta.created || ""
    const heading = when ? `### ${when} — ${title}` : `### ${title}`
    const rendered = heading + "\n" + note.body.trim()
    const size = Buffer.byteLength(rendered, "utf8")
    if (running + size > budget) break
    result.push(note)
    running += size
  }
  return result
}

function sectionBytes(sections: string[]): number {
  return sections.reduce((acc, s) => acc + Buffer.byteLength(s, "utf8") + 2, 0)
}

function basenameFromPath(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx >= 0 ? p.slice(idx + 1) : p
}

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf(".")
  return idx > 0 ? filename.slice(0, idx) : filename
}

/**
 * Progressive disclosure: emit a compact index listing title + description
 * + refs for each memory, without the full bodies. The LLM reads full
 * bodies on demand via `/memory show <path>`.
 *
 * Bytes target: ~20-40 bytes per entry + headers. A scope with 100 memories
 * uses ~2-4KB — well within budget even for large vaults.
 */
function formatIndexBlock(
  scope: Scope,
  docs: VaultDocs,
  opts: InjectorOptions,
  refHealth?: RefHealthMap,
): string {
  const lines: string[] = []
  const staleMark = (doc: MemoryDoc): string => {
    const h = refHealth?.get(doc.path)
    if (!h) return ""
    if (h.allBroken) return " [all-refs-stale]"
    if (h.brokenCount > 0) return ` [${h.brokenCount}-stale-refs]`
    return ""
  }

  const pushShared = (label: string, doc: MemoryDoc | undefined) => {
    if (!doc) return
    if (isInvalidated(doc)) return
    const h = refHealth?.get(doc.path)
    if (h?.allBroken) return
    const title = doc.meta["title"] || label
    const desc = doc.meta["description"] || firstMeaningfulLine(doc.body)
    const relPath = path.relative(scope.vaultRoot, doc.path)
    const tags = doc.meta["tags"] ? ` #${doc.meta["tags"].replace(/,/g, " #")}` : ""
    lines.push(`- [${label}] ${title}${staleMark(doc)} — ${desc}${tags}`)
    lines.push(`  path: ${relPath}`)
  }

  pushShared("user", docs.systemShared)
  pushShared("repo", docs.repoShared)
  pushShared(`branch:${scope.branchSlug}`, docs.branchShared)

  // Notes: compact one-liners per note (skip invalidated + all-broken)
  const validNotes = docs.notes.filter(
    (n) => !isInvalidated(n) && !refHealth?.get(n.path)?.allBroken,
  )
  if (validNotes.length > 0) {
    lines.push("")
    lines.push("recent-notes:")
    for (const note of validNotes) {
      const title = note.meta["title"] || stripExtension(basenameFromPath(note.path))
      const desc = note.meta["description"] || firstMeaningfulLine(note.body)
      const when = shortDate(note.meta["created"])
      const relPath = path.relative(scope.vaultRoot, note.path)
      const tags = note.meta["tags"] ? ` #${note.meta["tags"].replace(/,/g, " #")}` : ""
      const importance = note.meta["importance"] ? ` ★${note.meta["importance"]}` : ""
      lines.push(
        `- ${when} ${title}${importance}${staleMark(note)} — ${desc}${tags}`,
      )
      lines.push(`  path: ${relPath}`)
    }
  }

  if (lines.length === 0) return ""

  // Truncate to maxBytes if needed (drop oldest notes)
  let body = lines.join("\n")
  if (Buffer.byteLength(body, "utf8") > opts.maxBytes) {
    // Trim the notes section from the tail
    let cut = lines.length
    while (cut > 0 && Buffer.byteLength(lines.slice(0, cut).join("\n"), "utf8") > opts.maxBytes) {
      cut -= 2 // each note uses 2 lines
    }
    body = lines.slice(0, Math.max(cut, 0)).join("\n")
  }

  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8)
  return [
    `<memory-index repo="${scope.shortHash}" branch="${scope.branchSlug}" hash="${hash}">`,
    body,
    `Use /memory show <path> to read any entry in full.`,
    `</memory-index>`,
  ].join("\n")
}

function firstMeaningfulLine(body: string): string {
  const lines = body.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim().replace(/^[-*#>]\s+/, "")
    if (trimmed && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 120)
    }
  }
  return ""
}

function shortDate(iso: string | undefined): string {
  if (!iso) return "?"
  return iso.slice(0, 10)
}
