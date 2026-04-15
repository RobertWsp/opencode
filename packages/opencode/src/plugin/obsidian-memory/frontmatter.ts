/**
 * Minimal YAML frontmatter parser/serializer, tailored for Obsidian.
 *
 * Supports the YAML subset Obsidian uses for notes:
 *
 * - `^---\n<lines>\n---\n` delimiters (CRLF tolerated)
 * - Single-line `key: value` pairs (strings)
 * - Double-quoted `key: "value with : or #"`
 * - Inline arrays: `key: [a, b, c]` (with optional quoted items)
 * - Multiline arrays:
 *     ```
 *     key:
 *       - a
 *       - b
 *     ```
 * - Comment lines starting with `#`
 *
 * Obsidian specifics respected:
 * - `tags`, `aliases`, `links`, `refs` are always written as INLINE YAML
 *   arrays `[a, b, c]` because Obsidian interprets `tags: a,b,c` as a
 *   SINGLE literal tag containing commas and flags it as "Invalid tag name".
 * - When reading, legacy comma-separated strings are still accepted for
 *   backward compatibility with files written by earlier versions of the
 *   plugin.
 *
 * The backing store remains `Record<string, string>` — list-keys are stored
 * canonically as comma-separated strings for simple consumer code. The
 * serializer converts those back to YAML arrays on write.
 *
 * No nested objects, no block scalars, no anchors. Malformed input returns
 * sensible defaults rather than throwing.
 */

export interface Frontmatter {
  meta: Record<string, string>
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Keys that must be serialized as YAML arrays to keep Obsidian happy.
 * If you add a new list-valued metadata field, register it here.
 */
export const LIST_KEYS = new Set(["tags", "aliases", "links", "refs"])

export function parseFrontmatter(source: string): Frontmatter {
  const match = source.match(FRONTMATTER_RE)
  if (!match) return { meta: {}, body: source }

  const meta: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      i++
      continue
    }
    const colon = line.indexOf(":")
    if (colon < 0) {
      i++
      continue
    }
    const key = line.slice(0, colon).trim()
    if (!key) {
      i++
      continue
    }
    let rawValue = line.slice(colon + 1).trim()

    // Case 1: value on the SAME line
    if (rawValue.length > 0) {
      meta[key] = normalizeScalarOrInlineArray(rawValue)
      i++
      continue
    }

    // Case 2: value is a multiline list starting on the NEXT line
    // Collect indented `- item` entries until we hit a dedent.
    const items: string[] = []
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      const nextTrimmed = next.trim()
      if (!nextTrimmed) {
        j++
        continue
      }
      const bulletMatch = next.match(/^\s+-\s+(.*)$/)
      if (!bulletMatch) break
      items.push(stripMatchingQuotes(bulletMatch[1].trim()))
      j++
    }
    if (items.length > 0) {
      meta[key] = items.join(",")
      i = j
      continue
    }

    // Empty value, empty list — store empty string.
    meta[key] = ""
    i++
  }

  return { meta, body: match[2] ?? "" }
}

export function serializeFrontmatter(
  meta: Record<string, string>,
  body: string,
): string {
  const lines = ["---"]
  for (const [key, rawValue] of Object.entries(meta)) {
    const value = rawValue ?? ""
    lines.push(serializeLine(key, value))
  }
  lines.push("---")
  return lines.join("\n") + "\n" + body.replace(/^\n+/, "")
}

// ───────────────────────────────────────────────────────────────────
//  internals
// ───────────────────────────────────────────────────────────────────

function serializeLine(key: string, value: string): string {
  if (LIST_KEYS.has(key)) {
    return `${key}: ${serializeList(value)}`
  }
  const needsQuote =
    /[:"#\n]/.test(value) || value !== value.trim() || value.startsWith("[")
  return `${key}: ${needsQuote ? quoteYamlString(value) : value}`
}

/**
 * Render a list-valued field as an inline YAML array: `[a, b, "c d"]`.
 * Empty list becomes `[]`. Items containing YAML-problematic characters
 * are double-quoted; otherwise they stay bare so Obsidian renders them
 * as hashtags cleanly.
 */
function serializeList(value: string): string {
  const items = splitListValue(value)
  if (items.length === 0) return "[]"
  const encoded = items.map((item) => {
    if (needsQuotingInArray(item)) return quoteYamlString(item)
    return item
  })
  return `[${encoded.join(", ")}]`
}

/**
 * Decompose a canonical list value. Accepts three input forms for
 * robustness — everything normalizes to `string[]`:
 *
 * 1. Legacy comma-separated: `a,b,c`
 * 2. JSON array (legacy bug): `["a","b"]`
 * 3. Already-formatted YAML inline: `[a, b, c]`
 */
function splitListValue(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed) return []

  // JSON-array legacy form
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim()
    if (!inner) return []
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string")
      }
    } catch {
      // fall through to comma-split of inner
    }
    return inner
      .split(",")
      .map((s) => stripMatchingQuotes(s.trim()))
      .filter(Boolean)
  }

  // Comma-separated canonical form
  return trimmed
    .split(",")
    .map((s) => stripMatchingQuotes(s.trim()))
    .filter(Boolean)
}

/**
 * Normalize a scalar or inline-array value read from a frontmatter line
 * into our canonical form:
 *
 * - Inline array `[a, b, c]` → `"a,b,c"` (canonical comma-separated)
 * - Quoted string wrapping an inline array (legacy bug output) → array
 * - Obsidian wikilink `[[target]]` → preserved as-is (NOT an array)
 * - Quoted string `"foo bar"` → `foo bar`
 * - Bare string → returned as-is
 */
function normalizeScalarOrInlineArray(raw: string): string {
  // Obsidian wikilink — keep exact form, do not confuse with YAML array
  if (raw.startsWith("[[") && raw.endsWith("]]")) return raw
  // Plain inline array (bare form)
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return splitListValue(raw).join(",")
  }
  // Quoted wrapper around an inline array (legacy bug output shape)
  const stripped = stripMatchingQuotes(raw)
  if (stripped !== raw) {
    if (stripped.startsWith("[[") && stripped.endsWith("]]")) return stripped
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      return splitListValue(stripped).join(",")
    }
  }
  return stripped
}

function stripMatchingQuotes(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  return v
}

/**
 * Chars that force an array item to be double-quoted.
 * Includes whitespace of any kind because Obsidian's tag syntax does NOT
 * allow embedded spaces — an item like `with space` only works when
 * double-quoted.
 */
function needsQuotingInArray(item: string): boolean {
  return /[,:\[\]#"'&*!|>%@`{}\s]/.test(item)
}

function quoteYamlString(value: string): string {
  // JSON.stringify produces a valid double-quoted YAML string for our
  // limited subset (escaping \", \n, \\).
  return JSON.stringify(value)
}
