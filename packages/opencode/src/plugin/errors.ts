import type { ObsidianMemoryError } from "./obsidian-memory/errors"
import type { CodeGraphError } from "./code-graph/errors"

export type PluginError =
  | ({ plugin: "obsidian-memory" } & ObsidianMemoryError)
  | ({ plugin: "code-graph" } & CodeGraphError)

export function getPluginErrorMessage(err: PluginError): string {
  if (err.plugin === "obsidian-memory") {
    switch (err.type) {
      case "vault-not-found": return `[memory] vault not found at ${err.path}`
      case "haiku-rate-limit": return `[memory] haiku rate-limited; retry in ${Math.round(err.retryAfterMs / 1000)}s`
      case "haiku-circuit-open": return `[memory] gate circuit open until ${new Date(err.until).toISOString()}`
      case "index-corrupt": return `[memory] index corrupt at ${err.path}: ${err.detail}`
      case "frontmatter-parse-failed": return `[memory] frontmatter parse failed in ${err.path}: ${err.detail}`
    }
  }
  switch (err.type) {
    case "db-error": return `Database error: ${err.message}`
    case "parse-error": return `Parse error in ${err.file}: ${err.message}`
    case "ingest-error": return `Ingest error in ${err.file}: ${err.message}`
    case "tool-error": return `Tool '${err.tool}' error: ${err.message}`
    case "wasm-not-found": return `WASM grammar not found for language: ${err.language}`
  }
  const _exhaustive: never = err
  return `[unknown plugin error] ${JSON.stringify(_exhaustive)}`
}
