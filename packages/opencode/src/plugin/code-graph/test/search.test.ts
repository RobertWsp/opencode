import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { openDb, upsertNode } from "../db"
import { hybridSearch } from "../search"
import { NodeKind } from "../types"
import type { GraphNode } from "../types"

const dirs: string[] = []

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-search-"))
  dirs.push(dir)
  return openDb(path.join(dir, "test.db"))
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function node(name: string, kind: NodeKind = NodeKind.Function, file = "/src/a.ts"): GraphNode {
  return {
    id: `${file}::${name}`,
    kind,
    name,
    qualifiedName: `${file}::${name}`,
    filePath: file,
    lineStart: 1,
    lineEnd: 10,
    language: "ts",
    isTest: false,
    fileHash: "abc",
    updatedAt: Date.now(),
  }
}

describe("hybridSearch", () => {
  test("PaymentService Class in top-3 among 20 nodes", () => {
    const db = setup()
    const noise = [
      "processPayment", "handleRefund", "getInvoice", "createOrder",
      "updateCart", "deleteSession", "fetchUser", "logEvent",
      "parseToken", "validateInput", "sendEmail", "formatDate",
      "cacheResult", "retryRequest", "buildQuery", "renderTemplate",
      "watchChanges", "closeConnection", "loadConfig",
    ]
    upsertNode(db, node("PaymentService", NodeKind.Class, "/src/payment.ts"))
    for (const n of noise) upsertNode(db, node(n))
    const results = hybridSearch(db, "PaymentService")
    expect(results.length).toBeGreaterThan(0)
    expect(results.slice(0, 3).some((n) => n.name === "PaymentService" && n.kind === NodeKind.Class)).toBe(true)
    db.close()
  })

  test("kind filter restricts results to Class only", () => {
    const db = setup()
    upsertNode(db, node("FooService", NodeKind.Class))
    upsertNode(db, node("fooHelper", NodeKind.Function))
    const results = hybridSearch(db, "foo", { kind: NodeKind.Class })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((n) => n.kind === NodeKind.Class)).toBe(true)
    db.close()
  })

  test("contextFiles boost puts matching-file node first", () => {
    const db = setup()
    upsertNode(db, node("helper", NodeKind.Function, "/src/a.ts"))
    upsertNode(db, node("helper2", NodeKind.Function, "/src/b.ts"))
    const results = hybridSearch(db, "helper", { contextFiles: ["/src/a.ts"] })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].filePath).toBe("/src/a.ts")
    db.close()
  })

  test("returns empty array for non-matching query", () => {
    const db = setup()
    upsertNode(db, node("something"))
    const results = hybridSearch(db, "xyzzy_no_match_1234")
    expect(results).toHaveLength(0)
    db.close()
  })

  test("respects limit option", () => {
    const db = setup()
    for (let i = 0; i < 10; i++) upsertNode(db, node(`func${i}`))
    const results = hybridSearch(db, "func", { limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
    db.close()
  })

  test("PascalCase query boosts Class results above Functions", () => {
    const db = setup()
    upsertNode(db, node("OrderService", NodeKind.Class))
    upsertNode(db, node("OrderService", NodeKind.Function, "/src/b.ts"))
    const results = hybridSearch(db, "OrderService")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].kind).toBe(NodeKind.Class)
    db.close()
  })
})
