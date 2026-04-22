#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import path from "path"
import type { Database } from "bun:sqlite"
import { ensureDb } from "./db"
import { callers, callees, impact, nodeByQn, toNode, COLS } from "./graph"
import type { NodeRow } from "./graph"
import { hybridSearch } from "./search"
import { EdgeKind, NodeKind } from "./types"
import type { GraphNode, GraphEdge } from "./types"

const ROOT = process.env.CODE_GRAPH_ROOT ?? process.cwd()
const DB_PATH = path.join(ROOT, ".opencode", "code-graph.db")

let _db: Database | null = null
async function db() {
  if (!_db) _db = await ensureDb(DB_PATH)
  return _db
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function fail(msg: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }] }
}

function related(d: Database, qn: string, kind: EdgeKind, match: "src" | "tgt"): GraphNode[] {
  const other = match === "src" ? "tgt" : "src"
  return d
    .query<NodeRow, [string, string]>(
      `SELECT ${COLS} FROM edges e JOIN nodes n ON n.qualified_name = e.${other}
       WHERE e.${match} = ? AND e.kind = ?`,
    )
    .all(qn, kind)
    .map(toNode)
}

function subgraphEdges(d: Database, ids: Set<string>): GraphEdge[] {
  if (!ids.size) return []
  const list = [...ids]
  const ph = list.map(() => "?").join(",")
  return d
    .query<{ kind: string; src: string; tgt: string; file_path: string; line_number: number; confidence: string }, string[]>(
      `SELECT kind, src, tgt, file_path, line_number, confidence FROM edges
       WHERE src IN (${ph}) OR tgt IN (${ph})`,
    )
    .all(...list, ...list)
    .map((r) => ({
      kind: r.kind as EdgeKind,
      srcQualifiedName: r.src,
      tgtQualifiedName: r.tgt,
      filePath: r.file_path,
      lineNumber: r.line_number,
      confidence: r.confidence as "certain" | "inferred",
    }))
}

const QN = z.object({ qualified_name: z.string() })
const QN_DEPTH = QN.extend({ max_depth: z.number().int().min(1).max(20).optional() })
const SEARCH_INPUT = z.object({
  query: z.string(),
  kind: z.nativeEnum(NodeKind).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  context_files: z.array(z.string()).optional(),
})
const SUBGRAPH_INPUT = QN.extend({ depth: z.number().int().min(1).max(10).optional() })

const TOOLS = [
  {
    name: "code_graph.impact",
    description: "Blast-radius analysis: nodes that transitively depend on the given qualified name (CALLS, IMPORTS_FROM, DEPENDS_ON).",
    inputSchema: { type: "object", properties: { qualified_name: { type: "string" }, max_depth: { type: "number", default: 10 } }, required: ["qualified_name"] },
  },
  {
    name: "code_graph.callers_of",
    description: "Who calls the given function/method (recursive, up to max_depth).",
    inputSchema: { type: "object", properties: { qualified_name: { type: "string" }, max_depth: { type: "number", default: 10 } }, required: ["qualified_name"] },
  },
  {
    name: "code_graph.callees_of",
    description: "What the given function/method calls (recursive, up to max_depth).",
    inputSchema: { type: "object", properties: { qualified_name: { type: "string" }, max_depth: { type: "number", default: 10 } }, required: ["qualified_name"] },
  },
  {
    name: "code_graph.tests_for",
    description: "Test nodes that cover the given qualified name via TESTED_BY edges.",
    inputSchema: { type: "object", properties: { qualified_name: { type: "string" } }, required: ["qualified_name"] },
  },
  {
    name: "code_graph.imports_of",
    description: "Modules/symbols that the given node imports (IMPORTS_FROM edges, src side).",
    inputSchema: { type: "object", properties: { qualified_name: { type: "string" } }, required: ["qualified_name"] },
  },
  {
    name: "code_graph.importers_of",
    description: "Nodes that import the given qualified name (IMPORTS_FROM edges, tgt side).",
    inputSchema: { type: "object", properties: { qualified_name: { type: "string" } }, required: ["qualified_name"] },
  },
  {
    name: "code_graph.inheritors_of",
    description: "Classes that inherit from the given class (INHERITS edges, tgt side).",
    inputSchema: { type: "object", properties: { qualified_name: { type: "string" } }, required: ["qualified_name"] },
  },
  {
    name: "code_graph.search",
    description: "Hybrid FTS5+LIKE+RRF search over the code graph with optional kind filter and context-file boost.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: Object.values(NodeKind) },
        limit: { type: "number", default: 20 },
        context_files: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    },
  },
  {
    name: "code_graph.subgraph",
    description: "Local neighborhood of a node: the node itself plus its callers, callees, and connecting edges.",
    inputSchema: { type: "object", properties: { qualified_name: { type: "string" }, depth: { type: "number", default: 2 } }, required: ["qualified_name"] },
  },
  {
    name: "code_graph.stats",
    description: "Database statistics: total node count, edge count, file count, and breakdown by language.",
    inputSchema: { type: "object", properties: {} },
  },
]

const server = new Server({ name: "code-graph", version: "0.1.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  const d = await db()

  try {
    if (name === "code_graph.impact") {
      const { qualified_name, max_depth } = QN_DEPTH.parse(args)
      return ok(impact(d, qualified_name, max_depth))
    }

    if (name === "code_graph.callers_of") {
      const { qualified_name, max_depth } = QN_DEPTH.parse(args)
      return ok(callers(d, qualified_name, max_depth))
    }

    if (name === "code_graph.callees_of") {
      const { qualified_name, max_depth } = QN_DEPTH.parse(args)
      return ok(callees(d, qualified_name, max_depth))
    }

    if (name === "code_graph.tests_for") {
      const { qualified_name } = QN.parse(args)
      return ok(related(d, qualified_name, EdgeKind.TESTED_BY, "tgt"))
    }

    if (name === "code_graph.imports_of") {
      const { qualified_name } = QN.parse(args)
      return ok(related(d, qualified_name, EdgeKind.IMPORTS_FROM, "src"))
    }

    if (name === "code_graph.importers_of") {
      const { qualified_name } = QN.parse(args)
      return ok(related(d, qualified_name, EdgeKind.IMPORTS_FROM, "tgt"))
    }

    if (name === "code_graph.inheritors_of") {
      const { qualified_name } = QN.parse(args)
      return ok(related(d, qualified_name, EdgeKind.INHERITS, "tgt"))
    }

    if (name === "code_graph.search") {
      const { query, kind, limit, context_files } = SEARCH_INPUT.parse(args)
      return ok(hybridSearch(d, query, { kind, limit, contextFiles: context_files }))
    }

    if (name === "code_graph.subgraph") {
      const { qualified_name, depth = 2 } = SUBGRAPH_INPUT.parse(args)
      const center = nodeByQn(d, qualified_name)
      if (!center) return fail(`Node not found: ${qualified_name}`)
      const c = callers(d, qualified_name, depth)
      const e = callees(d, qualified_name, depth)
      const nodes = [center, ...c, ...e]
      const ids = new Set(nodes.map((n) => n.qualifiedName))
      return ok({ nodes, edges: subgraphEdges(d, ids) })
    }

    if (name === "code_graph.stats") {
      const nodes = (d.query<{ n: number }, []>("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n
      const edges = (d.query<{ n: number }, []>("SELECT COUNT(*) as n FROM edges").get() as { n: number }).n
      const files = (d.query<{ n: number }, []>("SELECT COUNT(*) as n FROM files").get() as { n: number }).n
      const langs = d
        .query<{ language: string; n: number }, []>(
          "SELECT language, COUNT(*) as n FROM nodes GROUP BY language ORDER BY n DESC",
        )
        .all()
        .reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.language]: r.n }), {})
      return ok({ nodes, edges, files, languages: langs })
    }

    return fail(`Unknown tool: ${name}`)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
