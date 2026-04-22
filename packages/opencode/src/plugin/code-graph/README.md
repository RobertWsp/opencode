# code-graph

SQLite-backed code graph plugin for opencode. Parses your repository with tree-sitter WASM grammars and exposes 10 MCP tools for impact analysis, call hierarchy, dependency tracing, and hybrid search.

## Supported languages

TypeScript, TSX, JavaScript, JSX, Python, Go, Rust

## Enable as built-in plugin

Add to your project's `opencode.jsonc`:

```jsonc
{
  "code_graph": {
    "enabled": true,
    "autoBuild": false,
    "watch": true,
    "dbPath": ".opencode/code-graph.db",
    "languages": ["ts", "tsx", "js", "jsx", "py", "go", "rs"],
    "maxFileBytes": 524288
  }
}
```

Build the initial graph manually:

```bash
opencode code-graph build
```

## External stdio MCP server

For use with other MCP-compatible tools, run the server with bun (requires opencode source checkout):

```json
{
  "mcp": {
    "code-graph": {
      "type": "local",
      "enabled": true,
      "command": [
        "/path/to/bun",
        "run",
        "/path/to/opencode/packages/opencode/src/plugin/code-graph/mcp-server.ts"
      ],
      "environment": {
        "CODE_GRAPH_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

The stdio MCP server requires bun and the opencode source tree. Binary-only users should use the built-in plugin instead.

## Tools (10)

`code_graph.impact` — blast radius of changed files  
`code_graph.callers_of` — callers of a function  
`code_graph.callees_of` — callees of a function  
`code_graph.tests_for` — tests covering a symbol  
`code_graph.imports_of` — what a file imports  
`code_graph.importers_of` — who imports a file  
`code_graph.inheritors_of` — subclasses of a class  
`code_graph.search` — hybrid FTS5 + RRF symbol search  
`code_graph.subgraph` — extract local subgraph  
`code_graph.stats` — node/edge counts per language  

## Config defaults

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable the plugin |
| `dbPath` | `.opencode/code-graph.db` | SQLite database path (relative to repo root) |
| `autoBuild` | `false` | Auto-build on startup — opt-in only |
| `languages` | `["ts","tsx","js","jsx","py","go","rs"]` | Languages to parse |
| `watch` | `true` | Watch for file changes and re-ingest incrementally |
| `maxFileBytes` | `524288` | Skip files larger than 512 KB |
| `ignore` | `["node_modules/**", ...]` | Glob patterns to exclude |
