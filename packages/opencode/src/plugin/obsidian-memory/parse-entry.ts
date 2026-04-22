import path from "path"
import {
  coerceConfidence,
  coerceMemoryKind,
  type MemoryDoc,
  type MemoryEntry,
  type MemoryKind,
} from "./types"

/**
 * Transform a raw `MemoryDoc` into an enriched `MemoryEntry` used by
 * retrieval, injector, and PageRank. Derived fields are parsed defensively:
 * missing / malformed frontmatter values fall back to sensible defaults.
 *
 * This is pure and fast (~1µs per doc). Runs on every `loadAll` call and
 * inside the vault index builder.
 */
export function toEntry(doc: MemoryDoc): MemoryEntry {
  const meta = doc.meta
  const title = meta["title"]?.trim() || stripExtension(path.basename(doc.path))
  const description = meta["description"]?.trim() || firstMeaningfulLine(doc.body)
  const tags = parseTags(meta["tags"])
  const links = parseLinks(meta["links"], doc.body)
  const importance = parseFloatOr(meta["importance"], 0.5)
  const created = meta["created"] || new Date(doc.mtimeMs).toISOString()
  const validFrom = meta["valid_from"] || meta["validFrom"] || created
  const validUntil = meta["valid_until"] || meta["validUntil"] || null
  const supersededBy = parseSupersededBy(meta["superseded_by"] || meta["supersededBy"])
  const kind = resolveKind(meta)
  const confidence = coerceConfidence(meta["confidence"])
  const confidence_score = parseOptionalFloat(meta["confidence_score"])

  return {
    doc,
    kind,
    title,
    description,
    tags,
    links,
    importance,
    created,
    validFrom,
    validUntil: validUntil === "null" || validUntil === "" ? null : validUntil,
    supersededBy,
    confidence,
    confidence_score,
  }
}

function parseOptionalFloat(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.min(1, n))
}

/**
 * Parse the comma-separated `tags` frontmatter field plus any `#hashtag`
 * hits in the body. Deduplicated, lowercased, trimmed.
 */
export function parseTags(rawFrontmatter: string | undefined): string[] {
  const out = new Set<string>()
  if (rawFrontmatter) {
    for (const tag of rawFrontmatter.split(",")) {
      const cleaned = tag.trim().replace(/^#+/, "").toLowerCase()
      if (cleaned) out.add(cleaned)
    }
  }
  return [...out]
}

/**
 * Parse wikilinks from both the `links` frontmatter field (comma-separated
 * or JSON array) and from `[[wikilink]]` tokens in the body. Case-preserved.
 */
export function parseLinks(rawFrontmatter: string | undefined, body: string): string[] {
  const out = new Set<string>()

  if (rawFrontmatter) {
    const trimmed = rawFrontmatter.trim()
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string" && item.trim()) out.add(item.trim())
          }
        }
      } catch {
        // fallback to comma split
      }
    }
    if (out.size === 0) {
      for (const link of trimmed.split(",")) {
        const cleaned = link.trim().replace(/^\[\[|\]\]$/g, "")
        if (cleaned) out.add(cleaned)
      }
    }
  }

  // Extract `[[target]]` from body
  const pattern = /\[\[([^\]\|\n]+)(?:\|[^\]]+)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    const target = match[1].trim()
    if (target) out.add(target)
  }

  return [...out]
}

/**
 * Parse `superseded_by` — accepts `[[target]]`, plain slug, or null-ish.
 */
function parseSupersededBy(raw: string | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/^\[\[|\]\]$/g, "")
  if (!cleaned || cleaned === "null") return null
  return cleaned
}

function parseFloatOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n))
}

function resolveKind(meta: Record<string, string>): MemoryKind {
  return coerceMemoryKind(meta["memory-kind"] || meta["kind"])
}

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf(".")
  return idx > 0 ? filename.slice(0, idx) : filename
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*#>]\s+/, "")
    if (trimmed && !trimmed.startsWith("---")) return trimmed.slice(0, 120)
  }
  return ""
}

/**
 * True when the memory is valid at the given instant (default: now).
 * Checks both `validFrom` (must be in the past) and `validUntil` (must be
 * in the future or absent). A memory with `valid_until == null` and
 * `validFrom <= now` is always valid.
 */
export function isValidAt(entry: MemoryEntry, atMs: number = Date.now()): boolean {
  // Check validFrom — memory is not yet active if we're before its start
  const from = Date.parse(entry.validFrom)
  if (Number.isFinite(from) && atMs < from) return false
  // Check validUntil — memory expired if we're past its end
  if (!entry.validUntil) return true
  const until = Date.parse(entry.validUntil)
  if (!Number.isFinite(until)) return true
  return atMs < until
}

/**
 * Slugify a title the same way `writeNote` does so wikilinks resolve
 * between the two producers.
 */
export function titleToSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "note"
  )
}
