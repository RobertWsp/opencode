import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { sanitizeFtsQuery, VaultIndex } from "../../../src/plugin/obsidian-memory/vault-index"
import { writeNote } from "../../../src/plugin/obsidian-memory/vault"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-idx-"))
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

describe("sanitizeFtsQuery", () => {
  test("converts to OR of quoted tokens", () => {
    expect(sanitizeFtsQuery("auth jwt middleware")).toBe('"auth" OR "jwt" OR "middleware"')
  })

  test("handles punctuation and parens", () => {
    expect(sanitizeFtsQuery("(auth) & jwt: token!")).toContain('"auth"')
    expect(sanitizeFtsQuery("(auth) & jwt: token!")).toContain('"jwt"')
  })

  test("returns empty on no usable tokens", () => {
    expect(sanitizeFtsQuery("")).toBe("")
    expect(sanitizeFtsQuery("!!!")).toBe("")
  })
})

describe("VaultIndex", () => {
  test("rebuild populates from filesystem", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "JWT middleware",
      body: "Validates tokens in requests",
      meta: { tags: "auth,jwt", "memory-kind": "gotcha" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "Build config",
      body: "Run bun run build:v2",
      meta: { tags: "build" },
      skipCommit: true,
    })

    const index = new VaultIndex(scope.vaultRoot)
    const count = await index.rebuild(scope)
    expect(count).toBe(2)
    expect(index.count()).toBe(2)
    index.close()
  })

  test("search returns BM25 hits for matching terms", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "Auth middleware setup",
      body: "The JWT middleware validates tokens and rejects expired ones",
      meta: { tags: "auth,jwt,middleware" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "Database pool",
      body: "Postgres connection pool config",
      meta: { tags: "db" },
      skipCommit: true,
    })
    const index = new VaultIndex(scope.vaultRoot)
    await index.rebuild(scope)

    const hits = index.search("jwt middleware")
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].memory.title).toBe("Auth middleware setup")
    index.close()
  })

  test("search excludes invalidated memories", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "old fact",
      body: "zustand v4 usage",
      meta: { tags: "zustand", valid_until: "2020-01-01T00:00:00Z" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "current fact",
      body: "zustand v5 usage",
      meta: { tags: "zustand" },
      skipCommit: true,
    })
    const index = new VaultIndex(scope.vaultRoot)
    await index.rebuild(scope)

    const hits = index.search("zustand")
    expect(hits.length).toBe(1)
    expect(hits[0].memory.title).toBe("current fact")
    index.close()
  })

  test("upsert adds new and updates existing", async () => {
    const scope = await makeScope()
    const index = new VaultIndex(scope.vaultRoot)
    index.open()

    const fp = await writeNote(scope, {
      title: "V1",
      body: "original",
      meta: { tags: "a" },
      skipCommit: true,
    })
    // Index manually via reconcile
    await index.reconcilePath(fp)
    expect(index.count()).toBe(1)

    // Second reconcile with no changes → skipped
    const status1 = await index.reconcilePath(fp)
    expect(status1).toBe("skipped")

    // Modify body and reconcile → upserted
    await fs.writeFile(
      fp,
      "---\ntitle: V1\ntags: a\nvalid_until: null\n---\ndifferent body now",
      "utf8",
    )
    const status2 = await index.reconcilePath(fp)
    expect(status2).toBe("upserted")

    // Missing file → deleted
    await fs.unlink(fp)
    const status3 = await index.reconcilePath(fp)
    expect(status3).toBe("deleted")
    expect(index.count()).toBe(0)
    index.close()
  })

  test("listAllValid returns mtime-desc without invalidated", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "first",
      body: "a",
      meta: { tags: "x" },
      skipCommit: true,
    })
    await new Promise((r) => setTimeout(r, 10))
    await writeNote(scope, {
      title: "second",
      body: "b",
      meta: { tags: "y" },
      skipCommit: true,
    })
    await writeNote(scope, {
      title: "invalid",
      body: "c",
      meta: { tags: "z", valid_until: "2020-01-01T00:00:00Z" },
      skipCommit: true,
    })
    const index = new VaultIndex(scope.vaultRoot)
    await index.rebuild(scope)
    const all = index.listAllValid(10)
    expect(all.length).toBe(2)
    expect(all[0].title).toBe("second")
    expect(all[1].title).toBe("first")
    index.close()
  })
})
