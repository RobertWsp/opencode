import type { MemoryEntry } from "./types"
import { tokenEstimate } from "./forgetting"
import path from "path"

export interface IndexEntry {
  id: string
  title: string
  kind: string
  importance: number
  tokens: number
  created: string
}

function shortId(p: string): string {
  return path.basename(p, ".md").slice(0, 24)
}

export function toIndex(entries: MemoryEntry[]): IndexEntry[] {
  return entries.map((e) => ({
    id: shortId(e.doc.path),
    title: e.title,
    kind: e.kind,
    importance: e.importance,
    tokens: tokenEstimate(e.doc.body),
    created: e.created,
  }))
}

export function formatIndex(entries: IndexEntry[]): string {
  if (entries.length === 0) return "[memory] no notes"
  const lines: string[] = [`[memory] ${entries.length} notes (use /memory get <id> for details)`]
  for (const e of entries) {
    const star = "★".repeat(Math.max(1, Math.round(e.importance * 5)))
    lines.push(`  ${e.id}  ${star}  [${e.kind}] ${e.title}  (~${e.tokens} tok)`)
  }
  const total = entries.reduce((s, e) => s + e.tokens, 0)
  lines.push(`  ──── total full-fetch cost: ~${total} tokens`)
  return lines.join("\n")
}
