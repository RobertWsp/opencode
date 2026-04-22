import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { openDb, upsertNode, upsertEdge } from "../db"
import { callers, callees, impact, nodeByQn, nodesByFile } from "../graph"
import { NodeKind, EdgeKind } from "../types"
import type { GraphNode, GraphEdge } from "../types"

const dirs: string[] = []

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-graph-"))
  dirs.push(dir)
  return openDb(path.join(dir, "test.db"))
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function node(name: string, file = "/a.ts"): GraphNode {
  return {
    id: `${file}::${name}`,
    kind: NodeKind.Function,
    name,
    qualifiedName: `${file}::${name}`,
    filePath: file,
    lineStart: 1,
    lineEnd: 5,
    language: "ts",
    isTest: false,
    fileHash: "abc",
    updatedAt: Date.now(),
  }
}

function edge(src: string, tgt: string, kind = EdgeKind.CALLS, file = "/a.ts"): GraphEdge {
  return { kind, srcQualifiedName: src, tgtQualifiedName: tgt, filePath: file, lineNumber: 1, confidence: "certain" }
}

describe("callers", () => {
  test("returns direct callers", () => {
    const db = setup()
    upsertNode(db, node("a"))
    upsertNode(db, node("b"))
    upsertNode(db, node("c"))
    upsertEdge(db, edge("/a.ts::b", "/a.ts::a"))
    upsertEdge(db, edge("/a.ts::c", "/a.ts::a"))
    const result = callers(db, "/a.ts::a")
    const names = result.map((n) => n.name)
    expect(names).toContain("b")
    expect(names).toContain("c")
    db.close()
  })

  test("returns empty when no callers", () => {
    const db = setup()
    upsertNode(db, node("lonely"))
    expect(callers(db, "/a.ts::lonely")).toHaveLength(0)
    db.close()
  })

  test("traverses transitively", () => {
    const db = setup()
    upsertNode(db, node("a"))
    upsertNode(db, node("b"))
    upsertNode(db, node("c"))
    upsertEdge(db, edge("/a.ts::b", "/a.ts::a"))
    upsertEdge(db, edge("/a.ts::c", "/a.ts::b"))
    const result = callers(db, "/a.ts::a", 5)
    const names = result.map((n) => n.name)
    expect(names).toContain("b")
    expect(names).toContain("c")
    db.close()
  })

  test("respects maxDepth", () => {
    const db = setup()
    upsertNode(db, node("a"))
    upsertNode(db, node("b"))
    upsertNode(db, node("c"))
    upsertEdge(db, edge("/a.ts::b", "/a.ts::a"))
    upsertEdge(db, edge("/a.ts::c", "/a.ts::b"))
    const direct = callers(db, "/a.ts::a", 1)
    expect(direct.map((n) => n.name)).toContain("b")
    expect(direct.map((n) => n.name)).not.toContain("c")
    db.close()
  })
})

describe("callees", () => {
  test("returns direct callees", () => {
    const db = setup()
    upsertNode(db, node("root"))
    upsertNode(db, node("helper"))
    upsertNode(db, node("util"))
    upsertEdge(db, edge("/a.ts::root", "/a.ts::helper"))
    upsertEdge(db, edge("/a.ts::root", "/a.ts::util"))
    const result = callees(db, "/a.ts::root")
    const names = result.map((n) => n.name)
    expect(names).toContain("helper")
    expect(names).toContain("util")
    db.close()
  })
})

describe("impact", () => {
  test("includes callers and importers", () => {
    const db = setup()
    upsertNode(db, node("core"))
    upsertNode(db, node("service"))
    upsertNode(db, node("controller"))
    upsertEdge(db, edge("/a.ts::service", "/a.ts::core"))
    upsertEdge(db, edge("/a.ts::controller", "/a.ts::core", EdgeKind.IMPORTS_FROM))
    const result = impact(db, "/a.ts::core")
    const names = result.map((n) => n.name)
    expect(names).toContain("service")
    expect(names).toContain("controller")
    db.close()
  })
})

describe("nodeByQn", () => {
  test("returns node by qualified name", () => {
    const db = setup()
    upsertNode(db, node("foo"))
    const result = nodeByQn(db, "/a.ts::foo")
    expect(result).not.toBeNull()
    expect(result?.name).toBe("foo")
    db.close()
  })

  test("returns null for unknown node", () => {
    const db = setup()
    expect(nodeByQn(db, "nonexistent::fn")).toBeNull()
    db.close()
  })
})

describe("nodesByFile", () => {
  test("returns all nodes for a file", () => {
    const db = setup()
    upsertNode(db, node("a", "/src/foo.ts"))
    upsertNode(db, node("b", "/src/foo.ts"))
    upsertNode(db, node("c", "/src/bar.ts"))
    const result = nodesByFile(db, "/src/foo.ts")
    expect(result).toHaveLength(2)
    expect(result.map((n) => n.name)).toContain("a")
    expect(result.map((n) => n.name)).toContain("b")
    db.close()
  })
})
