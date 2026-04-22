import type { Database } from "bun:sqlite"
import type { GraphNode } from "./types"
import { NodeKind } from "./types"
import { toNode, COLS } from "./graph"
import type { NodeRow } from "./graph"

export interface SearchOptions {
  kind?: NodeKind
  limit?: number
  contextFiles?: string[]
}

const K = 60

function fts(db: Database, query: string): GraphNode[] {
  const tokens = query
    .replace(/[^a-zA-Z0-9_]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!tokens.length) return []
  const q = tokens.map((t) => `${t}*`).join(" ")
  try {
    return db
      .query<NodeRow, [string]>(
        `SELECT ${COLS} FROM nodes_fts JOIN nodes n ON nodes_fts.rowid = n.rowid
         WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts) LIMIT 50`,
      )
      .all(q)
      .map(toNode)
  } catch {
    return []
  }
}

function likeSearch(db: Database, query: string): GraphNode[] {
  const pat = `%${query}%`
  return db
    .query<NodeRow, [string, string]>(
      `SELECT ${COLS} FROM nodes n WHERE n.name LIKE ? OR n.qualified_name LIKE ? LIMIT 50`,
    )
    .all(pat, pat)
    .map(toNode)
}

function isPascal(s: string) {
  return /^[A-Z][a-zA-Z0-9]*$/.test(s)
}

function isCamelOrSnake(s: string) {
  return /^[a-z]/.test(s) && (/[A-Z]/.test(s) || s.includes("_"))
}

function score(node: GraphNode, query: string, ctx?: string[]): number {
  let b = 1.0
  if (isPascal(query) && node.kind === NodeKind.Class) b *= 1.5
  if (isCamelOrSnake(query) && node.kind === NodeKind.Function) b *= 1.5
  if (ctx?.includes(node.filePath)) b *= 1.5
  if (node.qualifiedName.includes(".")) b *= 2.0
  return b
}

export function hybridSearch(db: Database, query: string, opts?: SearchOptions): GraphNode[] {
  const lim = opts?.limit ?? 20
  const ftsList = fts(db, query)
  const likeList = likeSearch(db, query)

  const scores = new Map<string, number>()
  const byId = new Map<string, GraphNode>()

  for (const list of [ftsList, likeList]) {
    list.forEach((n, i) => {
      scores.set(n.id, (scores.get(n.id) ?? 0) + 1 / (K + i + 1))
      if (!byId.has(n.id)) byId.set(n.id, n)
    })
  }

  return [...byId.values()]
    .filter((n) => !opts?.kind || n.kind === opts.kind)
    .map((n) => ({ n, s: (scores.get(n.id) ?? 0) * score(n, query, opts?.contextFiles) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, lim)
    .map((x) => x.n)
}
