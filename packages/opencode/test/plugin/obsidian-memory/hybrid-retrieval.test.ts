import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { hybridRank, HYBRID_WEIGHTS } from "../../../src/plugin/obsidian-memory/retrieval"
import { createVectorStore } from "../../../src/plugin/obsidian-memory/vector-store"
import { writeNote } from "../../../src/plugin/obsidian-memory/vault"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

const dirs: string[] = []

async function makeScope(): Promise<Scope> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omem-hybrid-"))
  dirs.push(root)
  const repoSlug = "test-abc"
  const branchSlug = "main"
  const repoDir = path.join(root, "opencode", "repos", repoSlug)
  const branchDir = path.join(repoDir, "branches", branchSlug)
  const notesDir = path.join(branchDir, "notes")
  const systemDir = path.join(root, "_system")
  await fs.mkdir(notesDir, { recursive: true })
  return {
    vaultRoot: root,
    basename: "test",
    shortHash: "abc",
    repoSlug,
    branchRaw: "main",
    branchSlug,
    repoDir,
    repoSharedPath: path.join(repoDir, "MEMORY.md"),
    branchDir,
    branchSharedPath: path.join(branchDir, "MEMORY.md"),
    notesDir,
    suggestedDir: path.join(branchDir, "suggested"),
    systemDir,
    systemSharedPath: path.join(systemDir, "MEMORY.md"),
  }
}

async function tmpdb(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-vdb-"))
  dirs.push(dir)
  return path.join(dir, "vec.db")
}

afterAll(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

function vec(...values: number[]): Float32Array {
  return new Float32Array(values)
}

describe("HYBRID_WEIGHTS", () => {
  test("sum to 1.0", () => {
    const sum = Object.values(HYBRID_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1.0, 2)
  })

  test("vector weight exceeds bm25 weight", () => {
    expect(HYBRID_WEIGHTS.vector).toBeGreaterThan(HYBRID_WEIGHTS.bm25)
  })
})

describe("hybridRank — empty vault", () => {
  test("returns empty array for empty vault", async () => {
    const scope = await makeScope()
    expect(await hybridRank(scope, "anything")).toEqual([])
  })

  test("returns empty array for empty query with no notes", async () => {
    const scope = await makeScope()
    expect(await hybridRank(scope, "")).toEqual([])
  })
})

describe("hybridRank — vector scoring", () => {
  test("vector score boosts semantically matching entry over high-importance non-match", async () => {
    const scope = await makeScope()
    const db = await tmpdb()

    // A: low importance, semantically close to query vector
    const pathA = await writeNote(scope, {
      title: "note-alpha",
      body: "alpha content",
      meta: { importance: "0.2" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "note-beta",
      body: "beta content",
      meta: { importance: "0.9" },
      skipCommit: true,
    })

    const store = createVectorStore(db)
    store.upsert(pathA, vec(1, 0, 0, 0))

    const result = await hybridRank(scope, "", {
      useFts5: false,
      vectorStore: store,
      queryVector: vec(1, 0, 0, 0),
    })
    store.close()

    expect(result[0].entry.title).toBe("note-alpha")
  })

  test("falls back to BM25-only when no vector store provided", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "jwt-auth",
      body: "JWT middleware token validation expired",
      meta: { importance: "0.5" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "db-setup",
      body: "postgres connection pool configuration",
      meta: { importance: "0.8" },
      skipCommit: true,
    })

    const result = await hybridRank(scope, "jwt token", { useFts5: false })
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].entry.title).toBe("jwt-auth")
  })

  test("without vector store, bm25+vector weight goes to bm25 — query match wins over high importance", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "unrelated",
      body: "totally different content",
      meta: { importance: "0.9" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "matching",
      body: "jwt authentication token middleware",
      meta: { importance: "0.1" },
      skipCommit: true,
    })

    const result = await hybridRank(scope, "jwt token", { useFts5: false })
    expect(result[0].entry.title).toBe("matching")
  })

  test("handles empty vector store (no hits)", async () => {
    const scope = await makeScope()
    const db = await tmpdb()
    await writeNote(scope, {
      title: "solo-note",
      body: "content",
      meta: { importance: "0.5" },
      skipCommit: true,
    })

    const store = createVectorStore(db)

    const result = await hybridRank(scope, "", {
      useFts5: false,
      vectorStore: store,
      queryVector: vec(1, 0, 0, 0),
    })
    store.close()

    expect(result.length).toBe(1)
    expect(result[0].entry.title).toBe("solo-note")
  })
})

describe("hybridRank — fileBoost", () => {
  test("fileBoost raises score for entries with matching refs", async () => {
    const scope = await makeScope()

    const pathA = await writeNote(scope, {
      title: "note-with-ref",
      body: "authentication module details",
      meta: { importance: "0.2", refs: "src/auth.ts" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "unrelated-note",
      body: "something completely different",
      meta: { importance: "0.5" },
      skipCommit: true,
    })

    const result = await hybridRank(scope, "", {
      useFts5: false,
      activeFiles: new Set(["src/auth.ts"]),
    })

    expect(result[0].entry.doc.path).toBe(pathA)
  })

  test("no boost applied when activeFiles is empty set", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "note-a",
      body: "some content",
      meta: { importance: "0.5", refs: "src/auth.ts" },
      skipCommit: true,
    })

    const result = await hybridRank(scope, "", {
      useFts5: false,
      activeFiles: new Set(),
    })
    expect(result.length).toBe(1)
  })

  test("fileBoost matches by basename when full path given", async () => {
    const scope = await makeScope()
    const pathA = await writeNote(scope, {
      title: "basename-match",
      body: "auth.ts module",
      meta: { importance: "0.2" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "no-match",
      body: "other content",
      meta: { importance: "0.7" },
      skipCommit: true,
    })

    const result = await hybridRank(scope, "", {
      useFts5: false,
      activeFiles: new Set(["src/server/auth.ts"]),
    })

    expect(result[0].entry.doc.path).toBe(pathA)
  })
})

describe("hybridRank — limit and determinism", () => {
  test("respects limit parameter", async () => {
    const scope = await makeScope()
    for (let i = 0; i < 5; i++) {
      await writeNote(scope, {
        title: `note-${i}`,
        body: "content",
        skipCommit: true,
      })
    }

    const result = await hybridRank(scope, "", { useFts5: false, limit: 3 })
    expect(result.length).toBe(3)
  })

  test("results are deterministic for identical inputs", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "alpha",
      body: "test alpha content",
      meta: { importance: "0.7" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "beta",
      body: "test beta content",
      meta: { importance: "0.3" },
      skipCommit: true,
    })

    const r1 = await hybridRank(scope, "test", { useFts5: false })
    const r2 = await hybridRank(scope, "test", { useFts5: false })

    expect(r1.map((r) => r.entry.title)).toEqual(r2.map((r) => r.entry.title))
  })

  test("excludes invalidated entries", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "valid",
      body: "content",
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "stale",
      body: "content",
      meta: { valid_until: "2020-01-01T00:00:00Z" },
      skipCommit: true,
    })

    const result = await hybridRank(scope, "", { useFts5: false })
    expect(result.length).toBe(1)
    expect(result[0].entry.title).toBe("valid")
  })

  test("returns all notes when count <= limit", async () => {
    const scope = await makeScope()
    await writeNote(scope, { title: "a", body: "x", skipCommit: true })
    await writeNote(scope, { title: "b", body: "y", skipCommit: true })

    const result = await hybridRank(scope, "", { useFts5: false, limit: 10 })
    expect(result.length).toBe(2)
  })
})

describe("hybridRank — pagerank integration", () => {
  test("pagerank boost raises score for entries in pagerank map", async () => {
    const scope = await makeScope()
    const pathA = await writeNote(scope, {
      title: "central",
      body: "central node content",
      meta: { importance: "0.3" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "peripheral",
      body: "peripheral node content",
      meta: { importance: "0.3" },
      skipCommit: true,
    })

    const pr = new Map([[pathA, 1.0]])
    const result = await hybridRank(scope, "", { useFts5: false, pagerankScores: pr })

    expect(result[0].entry.doc.path).toBe(pathA)
  })
})

describe("hybridRank — breakdown field", () => {
  test("exposes score breakdown with relevance and importance", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "jwt-note",
      body: "jwt token auth",
      meta: { importance: "0.6" },
      skipCommit: true,
    })

    const result = await hybridRank(scope, "jwt", { useFts5: false })
    expect(result[0].breakdown.recency).toBeGreaterThan(0)
    expect(result[0].breakdown.importance).toBe(0.6)
    expect(result[0].breakdown.relevance).toBeGreaterThan(0)
    expect(result[0].breakdown.pagerank).toBe(0)
  })
})
