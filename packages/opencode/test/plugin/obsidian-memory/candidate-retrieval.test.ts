import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import {
  __internal,
  loadAllEntries,
  selectCandidates,
} from "../../../src/plugin/obsidian-memory/candidate-retrieval"
import { writeNote } from "../../../src/plugin/obsidian-memory/vault"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-cand-"))
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

describe("tokenize", () => {
  test("extracts lowercase content words", () => {
    const tokens = __internal.tokenize("The Authentication Module Uses JWT Tokens")
    expect(tokens.has("authentication")).toBe(true)
    expect(tokens.has("module")).toBe(true)
    expect(tokens.has("jwt")).toBe(true)
    expect(tokens.has("tokens")).toBe(true)
  })

  test("drops stopwords", () => {
    const tokens = __internal.tokenize("the and for")
    expect(tokens.size).toBe(0)
  })

  test("keeps identifiers with _ and -", () => {
    const tokens = __internal.tokenize("useAuthStore and use-auth-store")
    expect(tokens.has("useauthstore")).toBe(true)
    expect(tokens.has("use-auth-store")).toBe(true)
  })

  test("drops tokens shorter than 3 chars", () => {
    const tokens = __internal.tokenize("js ts go rust")
    expect(tokens.has("js")).toBe(false)
    expect(tokens.has("ts")).toBe(false)
    expect(tokens.has("go")).toBe(false)
    expect(tokens.has("rust")).toBe(true)
  })
})

describe("jaccard", () => {
  test("perfect overlap → 1", () => {
    const a = new Set(["foo", "bar", "baz"])
    const b = new Set(["foo", "bar", "baz"])
    expect(__internal.jaccard(a, b)).toBe(1)
  })

  test("no overlap → 0", () => {
    expect(__internal.jaccard(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0)
  })

  test("half overlap", () => {
    expect(__internal.jaccard(new Set(["a", "b"]), new Set(["a", "c"]))).toBeCloseTo(1 / 3, 5)
  })

  test("empty input → 0", () => {
    expect(__internal.jaccard(new Set(), new Set(["a"]))).toBe(0)
  })
})

describe("loadAllEntries", () => {
  test("returns empty on fresh vault", async () => {
    const scope = await makeScope()
    const entries = await loadAllEntries(scope)
    expect(entries).toEqual([])
  })

  test("loads written notes as MemoryEntry", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "First Note",
      body: "Body content here",
      meta: { tags: "auth,jwt", "memory-kind": "gotcha", description: "auth gotcha" },
      skipCommit: true,
    })
    const entries = await loadAllEntries(scope)
    expect(entries.length).toBe(1)
    expect(entries[0].title).toBe("First Note")
    expect(entries[0].kind).toBe("gotcha")
    expect(entries[0].tags.sort()).toEqual(["auth", "jwt"])
  })
})

describe("selectCandidates", () => {
  test("returns empty when no matches", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "Python Notes",
      body: "use uv run pytest",
      meta: { tags: "python" },
      skipCommit: true,
    })
    const candidates = await selectCandidates(
      scope,
      { text: "react component rendering strategy" },
      { limit: 5 },
    )
    expect(candidates).toEqual([])
  })

  test("matches by token overlap", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "JWT Middleware",
      body: "The middleware validates JWT tokens in requests",
      meta: { tags: "auth,jwt,middleware", description: "JWT validation" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "Database Config",
      body: "Postgres connection pooling config",
      meta: { tags: "db,postgres" },
      skipCommit: true,
    })
    const candidates = await selectCandidates(
      scope,
      { text: "fixing jwt validation middleware bug" },
      { limit: 5 },
    )
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    expect(candidates[0].entry.title).toBe("JWT Middleware")
  })

  test("matches by explicit tags", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "Some Note",
      body: "foo bar baz",
      meta: { tags: "payment,stripe" },
      skipCommit: true,
    })
    const candidates = await selectCandidates(
      scope,
      { text: "unrelated text entirely", tags: ["payment"] },
      { limit: 5 },
    )
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    expect(candidates[0].entry.title).toBe("Some Note")
  })

  test("skips invalidated notes", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "Old Fact",
      body: "zustand v4 usage",
      meta: { tags: "zustand", valid_until: "2020-01-01T00:00:00Z" },
      skipCommit: true,
    })
    const candidates = await selectCandidates(
      scope,
      { text: "zustand state management" },
      { limit: 5 },
    )
    expect(candidates.length).toBe(0)
  })

  test("sorts by score desc", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "Weak Match",
      body: "mentions auth once",
      meta: { tags: "misc" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "Strong Match",
      body: "auth middleware jwt token validation",
      meta: { tags: "auth,jwt,middleware" },
      skipCommit: true,
    })
    const candidates = await selectCandidates(
      scope,
      { text: "auth middleware jwt token", tags: ["auth"] },
      { limit: 5 },
    )
    expect(candidates[0].entry.title).toBe("Strong Match")
  })

  test("respects limit", async () => {
    const scope = await makeScope()
    for (let i = 0; i < 5; i++) {
      await writeNote(scope, {
        title: `note ${i}`,
        body: "auth jwt token middleware",
        meta: { tags: "auth" },
        skipCommit: true,
      })
    }
    const candidates = await selectCandidates(
      scope,
      { text: "auth jwt token" },
      { limit: 2 },
    )
    expect(candidates.length).toBe(2)
  })
})
