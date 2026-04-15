import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { formatBlock } from "../../../src/plugin/obsidian-memory/injector"
import { parseFrontmatter } from "../../../src/plugin/obsidian-memory/frontmatter"
import { toEntry, isValidAt } from "../../../src/plugin/obsidian-memory/parse-entry"
import { invalidateNote, rewriteNote, writeNote } from "../../../src/plugin/obsidian-memory/vault"
import type { MemoryDoc, Scope } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-bitemporal-"))
  tempDirs.push(vaultRoot)
  const repoSlug = "test-abc123"
  const branchSlug = "main"
  const repoDir = path.join(vaultRoot, "opencode", "repos", repoSlug)
  const branchDir = path.join(repoDir, "branches", branchSlug)
  const notesDir = path.join(branchDir, "notes")
  const systemDir = path.join(vaultRoot, "_system")
  await fs.mkdir(notesDir, { recursive: true })
  return {
    vaultRoot,
    basename: "test",
    shortHash: "abc123",
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

function makeDoc(filepath: string, meta: Record<string, string>, body: string): MemoryDoc {
  return {
    path: filepath,
    meta,
    body,
    mtimeMs: Date.now(),
    size: body.length,
  }
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("writeNote bitemporal defaults", () => {
  test("sets valid_from and valid_until=null on new notes", async () => {
    const scope = await makeScope()
    const filepath = await writeNote(scope, { title: "test", body: "hello", skipCommit: true })
    const content = await fs.readFile(filepath, "utf8")
    const { meta } = parseFrontmatter(content)
    expect(meta.valid_from).toBeDefined()
    expect(meta.valid_until).toBe("null")
  })

  test("preserves memory-kind from meta patch", async () => {
    const scope = await makeScope()
    const filepath = await writeNote(scope, {
      title: "decision",
      body: "x",
      meta: { "memory-kind": "decision" },
      skipCommit: true,
    })
    const { meta } = parseFrontmatter(await fs.readFile(filepath, "utf8"))
    expect(meta["memory-kind"]).toBe("decision")
  })
})

describe("rewriteNote", () => {
  test("updates body while preserving created", async () => {
    const scope = await makeScope()
    const filepath = await writeNote(scope, { title: "t", body: "v1", skipCommit: true })
    const before = parseFrontmatter(await fs.readFile(filepath, "utf8")).meta
    await new Promise((r) => setTimeout(r, 5))
    const ok = await rewriteNote(scope, filepath, { body: "v2 updated", skipCommit: true })
    expect(ok).toBe(true)
    const after = parseFrontmatter(await fs.readFile(filepath, "utf8"))
    expect(after.body.trim()).toBe("v2 updated")
    expect(after.meta.created).toBe(before.created)
    expect(after.meta.updated).toBeDefined()
  })

  test("returns false for missing file", async () => {
    const scope = await makeScope()
    const ok = await rewriteNote(scope, "/tmp/does-not-exist.md", { body: "x", skipCommit: true })
    expect(ok).toBe(false)
  })
})

describe("invalidateNote", () => {
  test("sets valid_until to now and records reason", async () => {
    const scope = await makeScope()
    const filepath = await writeNote(scope, { title: "t", body: "old", skipCommit: true })
    const ok = await invalidateNote(scope, filepath, {
      reason: "superseded by v2",
      skipCommit: true,
    })
    expect(ok).toBe(true)
    const { meta } = parseFrontmatter(await fs.readFile(filepath, "utf8"))
    expect(meta.valid_until).toBeDefined()
    expect(meta.valid_until).not.toBe("null")
    expect(meta.invalidation_reason).toBe("superseded by v2")
    expect(meta.invalidated).toBeDefined()
  })

  test("records supersededBy as wikilink", async () => {
    const scope = await makeScope()
    const filepath = await writeNote(scope, { title: "old", body: "x", skipCommit: true })
    await invalidateNote(scope, filepath, { supersededBy: "new-note", skipCommit: true })
    const { meta } = parseFrontmatter(await fs.readFile(filepath, "utf8"))
    expect(meta.superseded_by).toBe("[[new-note]]")
  })

  test("strips double [[]] if caller provides them", async () => {
    const scope = await makeScope()
    const filepath = await writeNote(scope, { title: "old", body: "x", skipCommit: true })
    await invalidateNote(scope, filepath, { supersededBy: "[[already-wrapped]]", skipCommit: true })
    const { meta } = parseFrontmatter(await fs.readFile(filepath, "utf8"))
    expect(meta.superseded_by).toBe("[[already-wrapped]]")
  })
})

describe("injector filters invalidated memories", () => {
  const scope: Scope = {
    vaultRoot: "/vault",
    basename: "test",
    shortHash: "abc",
    repoSlug: "test-abc",
    branchRaw: "main",
    branchSlug: "main",
    repoDir: "/vault/opencode/repos/test-abc",
    repoSharedPath: "/vault/opencode/repos/test-abc/MEMORY.md",
    branchDir: "/vault/opencode/repos/test-abc/branches/main",
    branchSharedPath: "/vault/opencode/repos/test-abc/branches/main/MEMORY.md",
    notesDir: "/vault/opencode/repos/test-abc/branches/main/notes",
    systemDir: "/vault/_system",
    systemSharedPath: "/vault/_system/MEMORY.md",
  }

  test("invalidated shared doc is skipped in full mode", () => {
    const block = formatBlock(
      scope,
      {
        repoShared: makeDoc(
          scope.repoSharedPath,
          { valid_until: "2020-01-01T00:00:00Z" },
          "old content",
        ),
        notes: [],
      },
      { maxBytes: 4096 },
    )
    expect(block).toBe("")
  })

  test("valid shared doc is included", () => {
    const block = formatBlock(
      scope,
      {
        repoShared: makeDoc(
          scope.repoSharedPath,
          { valid_until: "null", title: "T" },
          "current",
        ),
        notes: [],
      },
      { maxBytes: 4096 },
    )
    expect(block).toContain("current")
  })

  test("mix of valid and invalidated notes: only valid injected", () => {
    const block = formatBlock(
      scope,
      {
        notes: [
          makeDoc(
            "/vault/opencode/repos/test-abc/branches/main/notes/a.md",
            { title: "alive", valid_until: "null" },
            "alive body",
          ),
          makeDoc(
            "/vault/opencode/repos/test-abc/branches/main/notes/b.md",
            { title: "dead", valid_until: "2020-01-01T00:00:00Z" },
            "dead body",
          ),
        ],
      },
      { maxBytes: 4096 },
    )
    expect(block).toContain("alive body")
    expect(block).not.toContain("dead body")
  })

  test("index mode also filters invalidated", () => {
    const block = formatBlock(
      scope,
      {
        notes: [
          makeDoc(
            "/vault/opencode/repos/test-abc/branches/main/notes/a.md",
            { title: "alive", valid_until: "null", created: "2026-04-15T00:00:00Z" },
            "alive",
          ),
          makeDoc(
            "/vault/opencode/repos/test-abc/branches/main/notes/b.md",
            { title: "dead", valid_until: "2020-01-01T00:00:00Z", created: "2026-04-14T00:00:00Z" },
            "dead",
          ),
        ],
      },
      { maxBytes: 4096 },
      undefined,
      "index",
    )
    expect(block).toContain("alive")
    expect(block).not.toContain("dead")
  })
})
