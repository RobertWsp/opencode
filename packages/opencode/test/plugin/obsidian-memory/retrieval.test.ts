import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { rankMemories, DEFAULT_WEIGHTS } from "../../../src/plugin/obsidian-memory/retrieval"
import { writeNote } from "../../../src/plugin/obsidian-memory/vault"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-rank-"))
  tempDirs.push(vaultRoot)
  const repoSlug = "test-abc"
  const branchSlug = "main"
  const repoDir = path.join(vaultRoot, "opencode", "repos", repoSlug)
  const branchDir = path.join(repoDir, "branches", branchSlug)
  const notesDir = path.join(branchDir, "notes")
  const systemDir = path.join(vaultRoot, "_system")
  await fs.mkdir(notesDir, { recursive: true })
  return {
    vaultRoot,
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

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("rankMemories — composed scoring", () => {
  test("returns empty for empty vault", async () => {
    const scope = await makeScope()
    const ranked = await rankMemories(scope, "anything")
    expect(ranked).toEqual([])
  })

  test("recency dominates for empty query (no relevance signal)", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "older",
      body: "a",
      meta: { tags: "misc", importance: "0.5" },
      skipCommit: true,
    })
    await new Promise((r) => setTimeout(r, 15))
    await writeNote(scope, {
      title: "newer",
      body: "b",
      meta: { tags: "misc", importance: "0.5" },
      skipCommit: true,
    })
    const ranked = await rankMemories(scope, "")
    expect(ranked[0].entry.title).toBe("newer")
  })

  test("relevance boosts semantically-matching entries", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "random note",
      body: "lorem ipsum dolor sit amet",
      meta: { tags: "misc", importance: "0.9" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "auth middleware gotcha",
      body: "JWT middleware rejects expired tokens in request handler",
      meta: { tags: "auth,jwt", importance: "0.5" },
      skipCommit: true,
    })
    const ranked = await rankMemories(scope, "jwt middleware token expired", {
      useFts5: false, // use jaccard fallback — no sqlite deps in test
    })
    // Even though the random note has higher importance (0.9 vs 0.5), the
    // relevance signal for auth should push it to #1 with default weights.
    expect(ranked[0].entry.title).toBe("auth middleware gotcha")
  })

  test("importance weight breaks ties", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "low importance",
      body: "generic content",
      meta: { tags: "misc", importance: "0.1" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "high importance",
      body: "generic content",
      meta: { tags: "misc", importance: "0.9" },
      skipCommit: true,
    })
    const ranked = await rankMemories(scope, "", { useFts5: false })
    expect(ranked[0].entry.title).toBe("high importance")
  })

  test("excludes invalidated memories", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "valid",
      body: "valid body",
      meta: { tags: "t" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "invalid",
      body: "stale body",
      meta: { tags: "t", valid_until: "2020-01-01T00:00:00Z" },
      skipCommit: true,
    })
    const ranked = await rankMemories(scope, "body", { useFts5: false })
    expect(ranked.length).toBe(1)
    expect(ranked[0].entry.title).toBe("valid")
  })

  test("respects custom limit", async () => {
    const scope = await makeScope()
    for (let i = 0; i < 5; i++) {
      await writeNote(scope, {
        title: `n${i}`,
        body: "x",
        meta: { tags: "t" },
        skipCommit: true,
      })
    }
    const ranked = await rankMemories(scope, "", { limit: 3, useFts5: false })
    expect(ranked.length).toBe(3)
  })

  test("pagerank weight raises score for entries in the map", async () => {
    const scope = await makeScope()
    const fp1 = await writeNote(scope, {
      title: "central",
      body: "x",
      meta: { tags: "t" },
      skipCommit: true,
    })
    const fp2 = await writeNote(scope, {
      title: "peripheral",
      body: "x",
      meta: { tags: "t" },
      skipCommit: true,
    })
    const pagerank = new Map([[fp1, 1.0]])
    const ranked = await rankMemories(scope, "", {
      pagerankScores: pagerank,
      useFts5: false,
    })
    expect(ranked[0].entry.doc.path).toBe(fp1)
  })

  test("breakdown reports component scores", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "t",
      body: "jwt token",
      meta: { tags: "auth", importance: "0.6" },
      skipCommit: true,
    })
    const ranked = await rankMemories(scope, "jwt", { useFts5: false })
    expect(ranked[0].breakdown.recency).toBeGreaterThan(0)
    expect(ranked[0].breakdown.importance).toBe(0.6)
    expect(ranked[0].breakdown.relevance).toBeGreaterThan(0)
    expect(ranked[0].breakdown.pagerank).toBe(0)
  })
})

describe("DEFAULT_WEIGHTS sanity", () => {
  test("sum to 1 (approximately)", () => {
    const sum =
      DEFAULT_WEIGHTS.recency +
      DEFAULT_WEIGHTS.importance +
      DEFAULT_WEIGHTS.relevance +
      DEFAULT_WEIGHTS.pagerank
    expect(sum).toBeCloseTo(1, 2)
  })

  test("relevance is the largest component", () => {
    expect(DEFAULT_WEIGHTS.relevance).toBeGreaterThan(DEFAULT_WEIGHTS.recency)
    expect(DEFAULT_WEIGHTS.relevance).toBeGreaterThan(DEFAULT_WEIGHTS.importance)
  })
})
