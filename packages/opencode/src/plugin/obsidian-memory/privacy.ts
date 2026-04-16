const PRIVATE_PATTERN = /<private>[\s\S]*?<\/private>/g
const REDACTED = "[REDACTED]"

export function stripPrivate(text: string): string {
  if (!text || typeof text !== "string") return text
  return text.replace(PRIVATE_PATTERN, REDACTED)
}

export function hasPrivate(text: string): boolean {
  if (!text) return false
  return PRIVATE_PATTERN.test(text)
}

export function sanitizeRecord(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return input
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(input)) {
    const v = input[k]
    if (typeof v === "string") {
      out[k] = stripPrivate(v)
      continue
    }
    out[k] = v
  }
  return out
}
