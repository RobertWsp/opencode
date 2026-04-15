/**
 * Minimal YAML frontmatter parser/serializer.
 *
 * Supports only the subset we need for memory files:
 * - `^---\n<lines>\n---\n` delimiters (CRLF tolerated)
 * - Single-line `key: value` pairs
 * - Comment lines starting with `#`
 *
 * No nested objects, no block scalars, no anchors. Malformed input returns
 * sensible defaults rather than throwing.
 */

export interface Frontmatter {
  meta: Record<string, string>
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseFrontmatter(source: string): Frontmatter {
  const match = source.match(FRONTMATTER_RE)
  if (!match) return { meta: {}, body: source }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    if (!key) continue
    let value = line.slice(colon + 1).trim()
    // Strip matching surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }
  return { meta, body: match[2] ?? "" }
}

export function serializeFrontmatter(meta: Record<string, string>, body: string): string {
  const lines = ["---"]
  for (const [key, rawValue] of Object.entries(meta)) {
    const value = rawValue ?? ""
    const needsQuote = /[:"#\n]/.test(value) || value !== value.trim()
    lines.push(`${key}: ${needsQuote ? JSON.stringify(value) : value}`)
  }
  lines.push("---")
  return lines.join("\n") + "\n" + body.replace(/^\n+/, "")
}
