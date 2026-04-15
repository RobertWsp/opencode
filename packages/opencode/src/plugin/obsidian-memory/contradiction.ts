import { promises as fs } from "fs"
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter"
import type { MemoryEntry } from "./types"

export interface ContradictionResult {
  path: string
  title: string
  similarity: number
}

const NEGATION = new Set([
  "not", "no", "never", "wrong", "incorrect", "broken",
  "fixed", "changed", "actually", "instead", "replaced",
  "removed", "deprecated", "obsolete", "outdated", "updated",
  "now", "however", "but", "revision", "correction",
])

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(w => w.length > 2))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sb = new Set(b)
  return a.filter(t => sb.has(t)).length / Math.max(a.length, b.length)
}

function sim(a: MemoryEntry, b: MemoryEntry): number {
  const title = jaccard(tokens(a.title), tokens(b.title))
  const tags = overlap(a.tags, b.tags)
  const body = jaccard(tokens(a.doc.body.slice(0, 500)), tokens(b.doc.body.slice(0, 500)))
  return title * 0.5 + tags * 0.3 + body * 0.2
}

function negated(body: string): boolean {
  const all = new Set(body.toLowerCase().split(/\W+/).filter(Boolean))
  for (const n of NEGATION) if (all.has(n)) return true
  return false
}

export async function detectContradiction(
  entry: MemoryEntry,
  candidates: MemoryEntry[],
  threshold = 0.85,
): Promise<ContradictionResult | null> {
  if (!negated(entry.doc.body)) return null
  let best: ContradictionResult | null = null
  for (const c of candidates) {
    if (c.supersededBy !== null || c.validUntil !== null) continue
    const s = sim(entry, c)
    if (s < threshold) continue
    if (best === null || s > best.similarity) {
      best = { path: c.doc.path, title: c.title, similarity: s }
    }
  }
  return best
}

export async function markSuperseded(fp: string, supersededBy: string): Promise<boolean> {
  const src = await fs.readFile(fp, "utf8").catch(() => null)
  if (src === null) return false
  const parsed = parseFrontmatter(src)
  const now = new Date().toISOString()
  const meta: Record<string, string> = { ...parsed.meta, valid_until: now, superseded_by: supersededBy }
  await fs.writeFile(fp, serializeFrontmatter(meta, parsed.body), "utf8")
  return true
}
