/**
 * Tests for the enhancements applied during the review cycle:
 *
 * 1. extractFilePaths — file context extraction from tool args
 * 2. File-aware retrieval boost — activeFiles boosts matching memories
 * 3. Bidirectional PageRank — A→B also creates B→A
 * 4. Truncation disclosure — dropped notes are surfaced
 * 5. Wikilink validation — links only to existing vault notes
 * 6. isValidAt with validFrom — bitemporal correctness
 */
import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { __internal as pluginInternal } from "../../../src/plugin/obsidian-memory"
import { rankMemories, DEFAULT_WEIGHTS } from "../../../src/plugin/obsidian-memory/retrieval"
import { computePageRank } from "../../../src/plugin/obsidian-memory/pagerank"
import { formatBlock } from "../../../src/plugin/obsidian-memory/injector"
import { writeNote } from "../../../src/plugin/obsidian-memory/vault"
import { isValidAt, toEntry } from "../../../src/plugin/obsidian-memory/parse-entry"
import type { MemoryDoc, Scope, VaultDocs } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-enh-"))
  tempDirs.push(vaultRoot)
  const repoSlug = "test-abc"
  const branchSlug = "main"
  const repoDir = path.join(vaultRoot, "opencode", "repos", repoSlug)
  const branchDir = path.join(repoDir, "branches", branchSlug)
  const notesDir = path.join(branchDir, "notes")
  const suggestedDir = path.join(branchDir, "suggested")
  const systemDir = path.join(vaultRoot, "_system")
  await fs.mkdir(notesDir, { recursive: true })
  await fs.mkdir(suggestedDir, { recursive: true })
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
    suggestedDir,
    systemDir,
    systemSharedPath: path.join(systemDir, "MEMORY.md"),
  }
}

function makeDoc(overrides: Partial<MemoryDoc> & { body?: string; meta?: Record<string, string> }): MemoryDoc {
  return {
    path: "/vault/notes/test.md",
    meta: {},
    body: "",
    mtimeMs: Date.now(),
    size: 100,
    ...overrides,
  }
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

// ─── 1. extractFilePaths ──────────────────────────────────────────────

describe("extractFilePaths", () => {
  const { extractFilePaths } = pluginInternal

  test("extracts file_path from read/edit/write tool args", () => {
    expect(extractFilePaths("read", { file_path: "/src/auth.ts" })).toEqual(["/src/auth.ts"])
    expect(extractFilePaths("edit", { file_path: "/src/config.ts", old_string: "a", new_string: "b" })).toEqual(["/src/config.ts"])
    expect(extractFilePaths("write", { file_path: "/src/new.ts" })).toEqual(["/src/new.ts"])
  })

  test("extracts path from glob/grep tool args", () => {
    expect(extractFilePaths("glob", { path: "/src" })).toEqual(["/src"])
    expect(extractFilePaths("grep", { path: "/src/utils" })).toEqual(["/src/utils"])
  })

  test("extracts file paths from bash commands", () => {
    const result = extractFilePaths("bash", { command: "cat src/auth.ts && head src/config.js" })
    expect(result).toContain("src/auth.ts")
    expect(result).toContain("src/config.js")
  })

  test("extracts .json paths from bash", () => {
    const result = extractFilePaths("bash", { command: "cat package.json" })
    expect(result).toContain("package.json")
  })

  test("handles bash commands with absolute paths", () => {
    const result = extractFilePaths("bash", { command: "vim /home/user/project/src/main.py" })
    expect(result).toContain("/home/user/project/src/main.py")
  })

  test("returns empty for no args", () => {
    expect(extractFilePaths("read", undefined)).toEqual([])
    expect(extractFilePaths("read", {})).toEqual([])
  })

  test("deduplicates paths", () => {
    const result = extractFilePaths("bash", { command: "cat src/foo.ts && grep bar src/foo.ts" })
    const unique = [...new Set(result)]
    expect(result.length).toBe(unique.length)
  })

  test("limits to 10 paths max", () => {
    // Construct a command with many file refs
    const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`).join(" && cat ")
    const result = extractFilePaths("bash", { command: `cat ${files}` })
    expect(result.length).toBeLessThanOrEqual(10)
  })
})

// ─── 2. File-aware retrieval boost ────────────────────────────────────

describe("file-aware retrieval boost", () => {
  test("memories mentioning active files rank higher", async () => {
    const scope = await makeScope()

    // Create two notes: one about auth.ts, one about unrelated topic
    await writeNote(scope, {
      title: "auth-middleware-pattern",
      body: "The auth middleware in src/auth.ts validates JWT tokens",
      meta: { refs: "src/auth.ts", importance: "0.5" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "database-migration-guide",
      body: "Run migrations with prisma migrate deploy",
      meta: { refs: "prisma/schema.prisma", importance: "0.5" },
      skipCommit: true,
    })

    // Rank WITHOUT activeFiles — both should have similar scores
    const withoutBoost = await rankMemories(scope, "how does authentication work", {
      useFts5: false,
    })

    // Rank WITH activeFiles including auth.ts — auth note should rank higher
    const withBoost = await rankMemories(scope, "how does authentication work", {
      useFts5: false,
      activeFiles: new Set(["src/auth.ts"]),
    })

    // Find auth note in both rankings
    const authWithout = withoutBoost.find((r) => r.entry.title === "auth-middleware-pattern")
    const authWith = withBoost.find((r) => r.entry.title === "auth-middleware-pattern")

    expect(authWithout).toBeDefined()
    expect(authWith).toBeDefined()
    // The boosted score should be higher
    expect(authWith!.score).toBeGreaterThan(authWithout!.score)
  })

  test("no boost when activeFiles don't match", async () => {
    const scope = await makeScope()

    await writeNote(scope, {
      title: "redis-cache-pattern",
      body: "Redis cache setup in src/cache.ts",
      meta: { refs: "src/cache.ts", importance: "0.5" },
      skipCommit: true,
    })

    const without = await rankMemories(scope, "caching", { useFts5: false })
    const with_ = await rankMemories(scope, "caching", {
      useFts5: false,
      activeFiles: new Set(["src/totally-unrelated.ts"]),
    })

    const scoreWithout = without.find((r) => r.entry.title === "redis-cache-pattern")?.score ?? 0
    const scoreWith = with_.find((r) => r.entry.title === "redis-cache-pattern")?.score ?? 0

    // Scores should be equal — no file match = no boost
    expect(scoreWith).toBeCloseTo(scoreWithout, 5)
  })
})

// ─── 3. Bidirectional PageRank ────────────────────────────────────────

describe("bidirectional PageRank", () => {
  test("backlinks contribute to rank (B→A created when A→B exists)", async () => {
    const scope = await makeScope()

    // A links B in frontmatter; B doesn't link A
    const pathA = await writeNote(scope, {
      title: "concept-a",
      body: "explanation of A",
      meta: { links: "concept-b" },
      skipCommit: true,
    })
    const pathB = await writeNote(scope, {
      title: "concept-b",
      body: "explanation of B (no explicit link to A)",
      skipCommit: true,
    })

    const result = await computePageRank(scope)
    // Should have 2 edges: A→B (forward) + B→A (backlink)
    expect(result.edgeCount).toBe(2)

    // Both should have non-zero scores (the backlink means B feeds A too)
    const scoreA = result.scores.get(pathA) ?? 0
    const scoreB = result.scores.get(pathB) ?? 0
    expect(scoreA).toBeGreaterThan(0)
    expect(scoreB).toBeGreaterThan(0)
  })

  test("mutual links create 2 edges (not 4 — no duplicates)", async () => {
    const scope = await makeScope()

    // A links B AND B links A explicitly
    await writeNote(scope, {
      title: "mutual-a",
      body: "see [[mutual-b]]",
      meta: { links: "mutual-b" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "mutual-b",
      body: "see [[mutual-a]]",
      meta: { links: "mutual-a" },
      skipCommit: true,
    })

    const result = await computePageRank(scope)
    // A→B (forward) + B→A (backlink from A's link) = 2
    // B→A (forward) + A→B (backlink from B's link) = 2 more, but A→B and B→A already exist
    // The addEdge function deduplicates, so total should be 2
    expect(result.edgeCount).toBe(2)
  })
})

// ─── 4. Truncation disclosure ─────────────────────────────────────────

describe("truncation disclosure", () => {
  test("surfaces count of dropped notes when budget exceeded", async () => {
    const scope = await makeScope()

    // Create enough notes to exceed a small budget
    for (let i = 0; i < 5; i++) {
      await writeNote(scope, {
        title: `note-${i}`,
        body: `Content for note ${i}. `.repeat(20), // ~400 bytes each
        skipCommit: true,
      })
    }

    // Load docs
    const entries = await fs.readdir(scope.notesDir)
    const notes: MemoryDoc[] = []
    for (const name of entries) {
      if (!name.endsWith(".md")) continue
      const full = path.join(scope.notesDir, name)
      const content = await fs.readFile(full, "utf8")
      const { parseFrontmatter } = await import("../../../src/plugin/obsidian-memory/frontmatter")
      const { meta, body } = parseFrontmatter(content)
      const st = await fs.stat(full)
      notes.push({ path: full, meta, body, mtimeMs: st.mtimeMs, size: st.size })
    }

    const docs: VaultDocs = { notes, systemShared: undefined, repoShared: undefined, branchShared: undefined }

    // Use a small budget so some notes get truncated
    const block = formatBlock(scope, docs, { maxBytes: 800 })

    expect(block).toContain("omitted due to byte budget")
    expect(block).toContain("/memory list")
  })

  test("no truncation message when all notes fit", async () => {
    const scope = await makeScope()

    await writeNote(scope, {
      title: "small-note",
      body: "Short content",
      skipCommit: true,
    })

    const entries = await fs.readdir(scope.notesDir)
    const notes: MemoryDoc[] = []
    for (const name of entries) {
      if (!name.endsWith(".md")) continue
      const full = path.join(scope.notesDir, name)
      const content = await fs.readFile(full, "utf8")
      const { parseFrontmatter } = await import("../../../src/plugin/obsidian-memory/frontmatter")
      const { meta, body } = parseFrontmatter(content)
      const st = await fs.stat(full)
      notes.push({ path: full, meta, body, mtimeMs: st.mtimeMs, size: st.size })
    }

    const docs: VaultDocs = { notes, systemShared: undefined, repoShared: undefined, branchShared: undefined }
    const block = formatBlock(scope, docs, { maxBytes: 6000 })

    expect(block).not.toContain("omitted")
  })
})

// ─── 5. isValidAt with validFrom ──────────────────────────────────────

describe("isValidAt bitemporal", () => {
  test("not valid before validFrom", () => {
    const entry = toEntry(makeDoc({
      meta: { valid_from: "2026-06-01T00:00:00Z" },
      mtimeMs: Date.parse("2026-06-01T00:00:00Z"),
    }))
    expect(isValidAt(entry, Date.parse("2026-05-01T00:00:00Z"))).toBe(false)
  })

  test("valid after validFrom and before validUntil", () => {
    const entry = toEntry(makeDoc({
      meta: {
        valid_from: "2026-04-01T00:00:00Z",
        valid_until: "2026-06-01T00:00:00Z",
      },
      mtimeMs: Date.parse("2026-04-01T00:00:00Z"),
    }))
    expect(isValidAt(entry, Date.parse("2026-05-01T00:00:00Z"))).toBe(true)
  })

  test("not valid after validUntil", () => {
    const entry = toEntry(makeDoc({
      meta: {
        valid_from: "2026-04-01T00:00:00Z",
        valid_until: "2026-04-10T00:00:00Z",
      },
      mtimeMs: Date.parse("2026-04-01T00:00:00Z"),
    }))
    expect(isValidAt(entry, Date.parse("2026-04-15T00:00:00Z"))).toBe(false)
  })

  test("always valid when no validUntil and validFrom in past", () => {
    const entry = toEntry(makeDoc({
      meta: { valid_from: "2020-01-01T00:00:00Z" },
      mtimeMs: Date.parse("2020-01-01T00:00:00Z"),
    }))
    expect(isValidAt(entry, Date.parse("2026-04-15T00:00:00Z"))).toBe(true)
  })
})

// ─── 6. Refs in frontmatter (LIST_KEYS) ─────────────────────────────

describe("refs serialized as YAML array", () => {
  test("refs field written as inline YAML array", async () => {
    const scope = await makeScope()
    const filepath = await writeNote(scope, {
      title: "test-refs",
      body: "content",
      meta: { refs: "src/auth.ts,src/config.ts" },
      skipCommit: true,
    })
    const content = await fs.readFile(filepath, "utf8")
    // refs is a LIST_KEY, so should be serialized as YAML array
    // Paths without YAML-problematic chars stay unquoted: [src/auth.ts, src/config.ts]
    expect(content).toContain("refs: [src/auth.ts, src/config.ts]")
    expect(content).not.toContain("refs: src/auth.ts,src/config.ts")
  })
})
