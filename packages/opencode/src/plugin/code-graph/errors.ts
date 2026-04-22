export type CodeGraphError =
  | { type: "db-error"; message: string; cause?: unknown }
  | { type: "parse-error"; file: string; message: string }
  | { type: "ingest-error"; file: string; message: string }
  | { type: "tool-error"; tool: string; message: string }
  | { type: "wasm-not-found"; language: string }

export function getCodeGraphErrorMessage(err: CodeGraphError): string {
  switch (err.type) {
    case "db-error":
      return `Database error: ${err.message}`
    case "parse-error":
      return `Parse error in ${err.file}: ${err.message}`
    case "ingest-error":
      return `Ingest error in ${err.file}: ${err.message}`
    case "tool-error":
      return `Tool '${err.tool}' error: ${err.message}`
    case "wasm-not-found":
      return `WASM grammar not found for language: ${err.language}`
  }
}
