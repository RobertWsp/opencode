export type ObsidianMemoryError =
  | { type: "vault-not-found"; path: string }
  | { type: "haiku-rate-limit"; retryAfterMs: number }
  | { type: "haiku-circuit-open"; until: number }
  | { type: "index-corrupt"; path: string; detail: string }
  | { type: "frontmatter-parse-failed"; path: string; detail: string }

export function getObsidianMemoryErrorMessage(err: ObsidianMemoryError): string {
  switch (err.type) {
    case "vault-not-found": return `[memory] vault not found at ${err.path}`
    case "haiku-rate-limit": return `[memory] haiku rate-limited; retry in ${Math.round(err.retryAfterMs/1000)}s`
    case "haiku-circuit-open": return `[memory] gate circuit open until ${new Date(err.until).toISOString()}`
    case "index-corrupt": return `[memory] index corrupt at ${err.path}: ${err.detail}`
    case "frontmatter-parse-failed": return `[memory] frontmatter parse failed in ${err.path}: ${err.detail}`
  }
}
