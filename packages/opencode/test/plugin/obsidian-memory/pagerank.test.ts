import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { computePageRank, seedsFromPrompt } from "../../../src/plugin/obsidian-memory/pagerank"
import { writeNote } from "../../../src/plugin/obsidian-memory/vault"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-pr-"))
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

describe("computePageRank", () => {
  test("empty vault returns empty scores", async () => {
    const scope = await makeScope()
    const result = await computePageRank(scope)
    expect(result.scores.size).toBe(0)
    expect(result.edgeCount).toBe(0)
  })

  test("single isolated note gets score 1", async () => {
    const scope = await makeScope()
    await writeNote(scope, { title: "lone note", body: "no links", skipCommit: true })
    const result = await computePageRank(scope)
    expect(result.scores.size).toBe(1)
    const score = [...result.scores.values()][0]
    expect(score).toBe(1)
  })

  test("highly-linked note ranks highest (uniform seeds)", async () => {
    const scope = await makeScope()
    const pathHub = await writeNote(scope, {
      title: "hub",
      body: "central node",
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "sat-a",
      body: "points to [[hub]]",
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "sat-b",
      body: "also [[hub]] here",
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "sat-c",
      body: "reference [[hub]]",
      skipCommit: true,
    })
    const result = await computePageRank(scope)
    // 3 forward edges (sat→hub) + 3 backlinks (hub→sat) = 6 bidirectional edges
    expect(result.edgeCount).toBe(6)
    expect(result.scores.get(pathHub)).toBe(1)
    // All satellites should score LESS than the hub
    for (const [path, score] of result.scores) {
      if (path !== pathHub) {
        expect(score).toBeLessThan(1)
      }
    }
  })

  test("personalized seeding shifts ranking toward matching nodes", async () => {
    const scope = await makeScope()
    const authPath = await writeNote(scope, {
      title: "auth jwt gotcha",
      body: "JWT expiration bug in middleware",
      meta: { tags: "auth,jwt" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "unrelated",
      body: "postgres connection pool tuning",
      meta: { tags: "db" },
      skipCommit: true,
    })

    const uniform = await computePageRank(scope)
    const personalized = await computePageRank(scope, {
      queryTokens: seedsFromPrompt("auth jwt middleware"),
    })

    // Personalized should bias auth note's score upward relative to the uniform case
    const authUniform = uniform.scores.get(authPath) ?? 0
    const authPersonalized = personalized.scores.get(authPath) ?? 0
    expect(authPersonalized).toBeGreaterThanOrEqual(authUniform)
  })

  test("skips invalidated notes from graph", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "alive",
      body: "valid",
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "dead",
      body: "gone",
      meta: { valid_until: "2020-01-01T00:00:00Z" },
      skipCommit: true,
    })
    const result = await computePageRank(scope)
    expect(result.scores.size).toBe(1)
  })

  test("explicit seeds override query tokens", async () => {
    const scope = await makeScope()
    const p1 = await writeNote(scope, { title: "n1", body: "x", skipCommit: true })
    const p2 = await writeNote(scope, { title: "n2", body: "y", skipCommit: true })
    const result = await computePageRank(scope, {
      seeds: new Map([[p1, 1]]),
    })
    const s1 = result.scores.get(p1) ?? 0
    const s2 = result.scores.get(p2) ?? 0
    // p1 should be strictly higher than p2 because all teleport mass lands on it
    expect(s1).toBeGreaterThan(s2)
  })

  test("converges within maxIter", async () => {
    const scope = await makeScope()
    for (let i = 0; i < 10; i++) {
      await writeNote(scope, {
        title: `n${i}`,
        body: `points to [[n${(i + 1) % 10}]]`,
        skipCommit: true,
      })
    }
    const result = await computePageRank(scope, { maxIter: 100, eps: 1e-6 })
    expect(result.iterations).toBeLessThanOrEqual(100)
    expect(result.scores.size).toBe(10)
  })

  test("dangling nodes distribute mass uniformly", async () => {
    const scope = await makeScope()
    await writeNote(scope, { title: "dangle", body: "no links at all", skipCommit: true })
    await writeNote(scope, { title: "other", body: "also no links", skipCommit: true })
    const result = await computePageRank(scope)
    // Two dangling nodes should end up with approximately equal scores
    const scores = [...result.scores.values()]
    expect(Math.abs(scores[0] - scores[1])).toBeLessThan(0.01)
  })
})

describe("seedsFromPrompt", () => {
  test("tokenizes like candidate-retrieval", () => {
    const seeds = seedsFromPrompt("fix the JWT auth middleware")
    expect(seeds.has("jwt")).toBe(true)
    expect(seeds.has("auth")).toBe(true)
    expect(seeds.has("middleware")).toBe(true)
    expect(seeds.has("the")).toBe(false) // stopword
  })
})
