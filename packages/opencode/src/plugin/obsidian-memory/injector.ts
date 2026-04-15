import { createHash } from "crypto"
import type { InjectorOptions, MemoryDoc, Scope, VaultDocs } from "./types"

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
export function formatBlock(scope: Scope, docs: VaultDocs, opts: InjectorOptions): string {
  const sections: string[] = []

  if (docs.repoShared?.body.trim()) {
    sections.push("## Shared (repo)\n" + docs.repoShared.body.trim())
  }
  if (docs.branchShared?.body.trim()) {
    sections.push(`## Shared (branch: ${scope.branchSlug})\n${docs.branchShared.body.trim()}`)
  }

  const notesToRender = truncateNotes(docs.notes, sectionBytes(sections), opts.maxBytes)
  if (notesToRender.length > 0) {
    const noteLines = ["## Recent Notes"]
    for (const note of notesToRender) {
      const title = note.meta.title || stripExtension(basenameFromPath(note.path))
      const when = note.meta.created || ""
      const heading = when ? `### ${when} — ${title}` : `### ${title}`
      noteLines.push(heading, note.body.trim())
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
