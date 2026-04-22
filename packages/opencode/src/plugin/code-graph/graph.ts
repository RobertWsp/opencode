import type { Database } from "bun:sqlite"
import { NodeKind, EdgeKind } from "./types"
import type { GraphNode, Language } from "./types"

interface NodeRow {
  id: string
  kind: string
  name: string
  qualified_name: string
  file_path: string
  line_start: number
  line_end: number
  language: string
  parent_name: string | null
  signature: string | null
  is_test: number
  file_hash: string
  extra: string | null
  updated_at: number
}

function toNode(r: NodeRow): GraphNode {
  return {
    id: r.id,
    kind: r.kind as NodeKind,
    name: r.name,
    qualifiedName: r.qualified_name,
    filePath: r.file_path,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    language: r.language as Language,
    parentName: r.parent_name ?? undefined,
    signature: r.signature ?? undefined,
    isTest: r.is_test === 1,
    fileHash: r.file_hash,
    extra: r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : undefined,
    updatedAt: r.updated_at,
  }
}

const COLS = "n.id, n.kind, n.name, n.qualified_name, n.file_path, n.line_start, n.line_end, n.language, n.parent_name, n.signature, n.is_test, n.file_hash, n.extra, n.updated_at"

export function callers(db: Database, qn: string, maxDepth = 10): GraphNode[] {
  const sql = `
    WITH RECURSIVE walk(node, depth) AS (
      SELECT e.src, 1 FROM edges e WHERE e.tgt = ? AND e.kind = ?
      UNION ALL
      SELECT e.src, walk.depth + 1 FROM edges e
      JOIN walk ON e.tgt = walk.node
      WHERE e.kind = ? AND walk.depth < ?
    )
    SELECT DISTINCT ${COLS} FROM nodes n JOIN walk ON n.qualified_name = walk.node
  `
  return db.query<NodeRow, [string, string, string, number]>(sql)
    .all(qn, EdgeKind.CALLS, EdgeKind.CALLS, maxDepth)
    .map(toNode)
}

export function callees(db: Database, qn: string, maxDepth = 10): GraphNode[] {
  const sql = `
    WITH RECURSIVE walk(node, depth) AS (
      SELECT e.tgt, 1 FROM edges e WHERE e.src = ? AND e.kind = ?
      UNION ALL
      SELECT e.tgt, walk.depth + 1 FROM edges e
      JOIN walk ON e.src = walk.node
      WHERE e.kind = ? AND walk.depth < ?
    )
    SELECT DISTINCT ${COLS} FROM nodes n JOIN walk ON n.qualified_name = walk.node
  `
  return db.query<NodeRow, [string, string, string, number]>(sql)
    .all(qn, EdgeKind.CALLS, EdgeKind.CALLS, maxDepth)
    .map(toNode)
}

export function impact(db: Database, qn: string, maxDepth = 10): GraphNode[] {
  const kinds = [EdgeKind.CALLS, EdgeKind.IMPORTS_FROM, EdgeKind.DEPENDS_ON].join("','")
  const sql = `
    WITH RECURSIVE walk(node, depth) AS (
      SELECT e.src, 1 FROM edges e WHERE e.tgt = ? AND e.kind IN ('${kinds}')
      UNION ALL
      SELECT e.src, walk.depth + 1 FROM edges e
      JOIN walk ON e.tgt = walk.node
      WHERE e.kind IN ('${kinds}') AND walk.depth < ?
    )
    SELECT DISTINCT ${COLS} FROM nodes n JOIN walk ON n.qualified_name = walk.node
  `
  return db.query<NodeRow, [string, number]>(sql).all(qn, maxDepth).map(toNode)
}

export function nodeByQn(db: Database, qn: string): GraphNode | null {
  const sql = `SELECT ${COLS} FROM nodes n WHERE n.qualified_name = ?`
  const row = db.query<NodeRow, [string]>(sql).get(qn)
  return row ? toNode(row) : null
}

export function nodesByFile(db: Database, filePath: string): GraphNode[] {
  const sql = `SELECT ${COLS} FROM nodes n WHERE n.file_path = ? ORDER BY n.line_start`
  return db.query<NodeRow, [string]>(sql).all(filePath).map(toNode)
}
