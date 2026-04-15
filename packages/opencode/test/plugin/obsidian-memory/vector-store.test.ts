import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { createVectorStore, cosine } from "../../../src/plugin/obsidian-memory/vector-store"

const dirs: string[] = []

async function tmpdb(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-vec-"))
  dirs.push(dir)
  return path.join(dir, "test.db")
}

afterAll(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

function vec(values: number[]): Float32Array {
  return new Float32Array(values)
}

describe("cosine", () => {
  test("returns 1.0 for identical vectors", () => {
    const a = vec([1, 0, 0])
    expect(cosine(a, a)).toBeCloseTo(1.0)
  })

  test("returns 0 for orthogonal vectors", () => {
    expect(cosine(vec([1, 0, 0]), vec([0, 1, 0]))).toBeCloseTo(0)
  })

  test("returns -1 for opposite vectors", () => {
    expect(cosine(vec([1, 0, 0]), vec([-1, 0, 0]))).toBeCloseTo(-1)
  })

  test("returns 0 for zero vector", () => {
    expect(cosine(vec([0, 0, 0]), vec([1, 2, 3]))).toBe(0)
  })

  test("handles non-unit vectors correctly", () => {
    expect(cosine(vec([2, 0, 0]), vec([5, 0, 0]))).toBeCloseTo(1.0)
  })
})

describe("createVectorStore", () => {
  test("creates SQLite database with memory_vectors table", async () => {
    const db = await tmpdb()
    const store = createVectorStore(db)
    const results = store.search(vec([1, 0, 0]), 10)
    expect(results).toEqual([])
    store.close()
  })

  test("upsert stores a vector retrievable via search", async () => {
    const store = createVectorStore(await tmpdb())
    store.upsert("notes/test.md", vec([1, 0, 0, 0]))
    const results = store.search(vec([1, 0, 0, 0]), 10)
    expect(results).toHaveLength(1)
    expect(results[0]!.path).toBe("notes/test.md")
    expect(results[0]!.score).toBeCloseTo(1.0)
    store.close()
  })

  test("upsert updates existing vector for same path", async () => {
    const store = createVectorStore(await tmpdb())
    store.upsert("notes/a.md", vec([1, 0, 0, 0]))
    store.upsert("notes/a.md", vec([0, 1, 0, 0]))
    const results = store.search(vec([0, 1, 0, 0]), 10)
    expect(results).toHaveLength(1)
    expect(results[0]!.path).toBe("notes/a.md")
    expect(results[0]!.score).toBeCloseTo(1.0)
    store.close()
  })

  test("search returns results sorted by cosine similarity descending", async () => {
    const store = createVectorStore(await tmpdb())
    store.upsert("a.md", vec([1, 0, 0, 0]))
    store.upsert("b.md", vec([0.7, 0.7, 0, 0]))
    store.upsert("c.md", vec([0, 1, 0, 0]))
    const results = store.search(vec([1, 0, 0, 0]), 10)
    expect(results[0]!.path).toBe("a.md")
    expect(results[0]!.score).toBeCloseTo(1.0)
    expect(results[1]!.score).toBeGreaterThan(results[2]!.score)
    store.close()
  })

  test("search returns empty array for empty store", async () => {
    const store = createVectorStore(await tmpdb())
    expect(store.search(vec([1, 0, 0]), 10)).toEqual([])
    store.close()
  })

  test("search respects limit parameter", async () => {
    const store = createVectorStore(await tmpdb())
    store.upsert("a.md", vec([1, 0, 0, 0]))
    store.upsert("b.md", vec([0, 1, 0, 0]))
    store.upsert("c.md", vec([0, 0, 1, 0]))
    const results = store.search(vec([1, 0, 0, 0]), 2)
    expect(results).toHaveLength(2)
    store.close()
  })

  test("remove deletes vector by path", async () => {
    const store = createVectorStore(await tmpdb())
    store.upsert("notes/x.md", vec([1, 0, 0, 0]))
    store.remove("notes/x.md")
    expect(store.search(vec([1, 0, 0, 0]), 10)).toHaveLength(0)
    store.close()
  })

  test("vectors survive database close and reopen", async () => {
    const db = await tmpdb()
    const s1 = createVectorStore(db)
    s1.upsert("persist.md", vec([0.1, 0.2, 0.3, 0.4]))
    s1.close()

    const s2 = createVectorStore(db)
    const results = s2.search(vec([0.1, 0.2, 0.3, 0.4]), 10)
    expect(results).toHaveLength(1)
    expect(results[0]!.path).toBe("persist.md")
    expect(results[0]!.score).toBeCloseTo(1.0)
    s2.close()
  })
})
