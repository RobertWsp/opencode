import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { openDb, storeFileBatch, getFileHash, deleteFileGraph, upsertNode } from "../db"
import { NodeKind, EdgeKind } from "../types"
import type { GraphNode, GraphEdge } from "../types"

function tmpDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-test-"))
  return { db: openDb(path.join(dir, "test.db")), dir }
}

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "test::fn",
    kind: NodeKind.Function,
    name: "fn",
    qualifiedName: "test::fn",
    filePath: "/test.ts",
    lineStart: 1,
    lineEnd: 5,
    language: "ts",
    isTest: false,
    fileHash: "abc123",
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    kind: EdgeKind.CALLS,
    srcQualifiedName: "a::fn",
    tgtQualifiedName: "b::fn",
    filePath: "/test.ts",
    lineNumber: 3,
    confidence: "certain",
    ...overrides,
  }
}

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe("openDb", () => {
  test("creates tables and FTS5", () => {
    const { db, dir } = tmpDb()
    dirs.push(dir)
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table','shadow')").all()
    const names = tables.map((t) => t.name)
    expect(names).toContain("nodes")
    expect(names).toContain("edges")
    expect(names).toContain("files")
    expect(names).toContain("metadata")
    expect(names).toContain("nodes_fts")
    db.close()
  })
})

describe("storeFileBatch", () => {
  test("inserts nodes + edges atomically", () => {
    const { db, dir } = tmpDb()
    dirs.push(dir)
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeNode({ id: `f::fn${i}`, qualifiedName: `f::fn${i}`, name: `fn${i}` }),
    )
    const edges = Array.from({ length: 3 }, (_, i) =>
      makeEdge({ srcQualifiedName: `f::fn${i}`, tgtQualifiedName: `f::fn${i + 1}` }),
    )
    storeFileBatch(db, "/test.ts", "hash1", "ts", nodes, edges)
    const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM nodes").get()!
    expect(count.c).toBe(5)
    db.close()
  })

  test("rollback on error — 0 nodes persisted", () => {
    const { db, dir } = tmpDb()
    dirs.push(dir)
    const nodes = [makeNode()]
    const dupNodes = [makeNode(), makeNode()]
    storeFileBatch(db, "/a.ts", "h1", "ts", nodes, [])
    expect(() => storeFileBatch(db, "/a.ts", "h1", "ts", dupNodes, [])).toThrow()
    const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM nodes").get()!
    expect(count.c).toBe(1)
    db.close()
  })

  test("getFileHash returns stored hash", () => {
    const { db, dir } = tmpDb()
    dirs.push(dir)
    storeFileBatch(db, "/f.ts", "deadbeef", "ts", [], [])
    expect(getFileHash(db, "/f.ts")).toBe("deadbeef")
    expect(getFileHash(db, "/other.ts")).toBeNull()
    db.close()
  })

  test("deleteFileGraph removes nodes + edges + file", () => {
    const { db, dir } = tmpDb()
    dirs.push(dir)
    const nodes = [makeNode({ id: "a::fn", qualifiedName: "a::fn", filePath: "/a.ts" })]
    storeFileBatch(db, "/a.ts", "h1", "ts", nodes, [])
    deleteFileGraph(db, "/a.ts")
    expect(getFileHash(db, "/a.ts")).toBeNull()
    const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM nodes").get()!
    expect(count.c).toBe(0)
    db.close()
  })
})

describe("FTS5", () => {
  test("MATCH prefix search returns matching nodes", () => {
    const { db, dir } = tmpDb()
    dirs.push(dir)
    const nodes = [
      makeNode({ id: "a::handlePayment", qualifiedName: "a::handlePayment", name: "handlePayment" }),
      makeNode({ id: "a::processOrder", qualifiedName: "a::processOrder", name: "processOrder" }),
      makeNode({ id: "a::handleRefund", qualifiedName: "a::handleRefund", name: "handleRefund" }),
    ]
    for (const node of nodes) upsertNode(db, node)
    const hits = db
      .query<{ name: string }, [string]>(
        "SELECT nodes.name FROM nodes JOIN nodes_fts ON nodes.rowid=nodes_fts.rowid WHERE nodes_fts MATCH ?",
      )
      .all("handle*")
    const names = hits.map((h) => h.name)
    expect(names).toContain("handlePayment")
    expect(names).toContain("handleRefund")
    expect(names).not.toContain("processOrder")
    db.close()
  })
})
