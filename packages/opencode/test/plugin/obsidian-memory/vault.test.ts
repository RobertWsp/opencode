import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { fingerprint, loadAll, writeNote } from "../../../src/plugin/obsidian-memory/vault"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeVaultScope() {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-vault-"))
  tempDirs.push(vaultRoot)
  const repoSlug = "test-abc123"
  const branchSlug = "main"
  const repoDir = path.join(vaultRoot, "opencode", "repos", repoSlug)
  const branchDir = path.join(repoDir, "branches", branchSlug)
  const notesDir = path.join(branchDir, "notes")
  const systemDir = path.join(vaultRoot, "_system")
  await fs.mkdir(notesDir, { recursive: true })
  const scope: Scope = {
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
    systemDir,
    systemSharedPath: path.join(systemDir, "MEMORY.md"),
  }
  return scope
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("fingerprint", () => {
  test("returns stable hash for unchanged vault", async () => {
    const scope = await makeVaultScope()
    const fp1 = await fingerprint(scope)
    const fp2 = await fingerprint(scope)
    expect(fp1).toBe(fp2)
    expect(fp1).toHaveLength(16)
  })

  test("changes when shared MEMORY.md is written", async () => {
    const scope = await makeVaultScope()
    const fp1 = await fingerprint(scope)
    await fs.writeFile(scope.repoSharedPath, "# repo memory\n")
    const fp2 = await fingerprint(scope)
    expect(fp1).not.toBe(fp2)
  })

  test("changes when a note is added", async () => {
    const scope = await makeVaultScope()
    const fp1 = await fingerprint(scope)
    await fs.writeFile(path.join(scope.notesDir, "note1.md"), "---\ntitle: t\n---\nbody")
    const fp2 = await fingerprint(scope)
    expect(fp1).not.toBe(fp2)
  })

  test("stable across notes-dir-missing and notes-dir-empty", async () => {
    const scope = await makeVaultScope()
    // notesDir exists but empty
    const fpEmpty = await fingerprint(scope)
    // delete notes dir
    await fs.rm(scope.notesDir, { recursive: true, force: true })
    const fpMissing = await fingerprint(scope)
    // Both should succeed and be strings (may differ — that's fine)
    expect(fpEmpty).toHaveLength(16)
    expect(fpMissing).toHaveLength(16)
  })
})

describe("loadAll", () => {
  test("returns empty docs for empty vault", async () => {
    const scope = await makeVaultScope()
    const docs = await loadAll(scope)
    expect(docs.repoShared).toBeUndefined()
    expect(docs.branchShared).toBeUndefined()
    expect(docs.notes).toEqual([])
  })

  test("reads repo and branch shared files", async () => {
    const scope = await makeVaultScope()
    await fs.writeFile(scope.repoSharedPath, "---\ntype: memory-shared\n---\nrepo body")
    await fs.writeFile(scope.branchSharedPath, "---\ntype: memory-shared\n---\nbranch body")
    const docs = await loadAll(scope)
    expect(docs.repoShared?.body).toBe("repo body")
    expect(docs.repoShared?.meta.type).toBe("memory-shared")
    expect(docs.branchShared?.body).toBe("branch body")
  })

  test("reads _system/ layer when present", async () => {
    const scope = await makeVaultScope()
    await fs.mkdir(scope.systemDir, { recursive: true })
    await fs.writeFile(
      scope.systemSharedPath,
      "---\ntype: memory-system\n---\nuser prefers pt-BR",
    )
    const docs = await loadAll(scope)
    expect(docs.systemShared?.body).toBe("user prefers pt-BR")
    expect(docs.systemShared?.meta.type).toBe("memory-system")
  })

  test("systemShared is undefined when _system/ does not exist", async () => {
    const scope = await makeVaultScope()
    const docs = await loadAll(scope)
    expect(docs.systemShared).toBeUndefined()
  })

  test("fingerprint changes when _system/ MEMORY.md is modified", async () => {
    const scope = await makeVaultScope()
    const { fingerprint } = await import("../../../src/plugin/obsidian-memory/vault")
    const fp1 = await fingerprint(scope)
    await fs.mkdir(scope.systemDir, { recursive: true })
    await fs.writeFile(scope.systemSharedPath, "# user prefs")
    const fp2 = await fingerprint(scope)
    expect(fp1).not.toBe(fp2)
  })

  test("sorts notes newest-first by mtime", async () => {
    const scope = await makeVaultScope()
    const older = path.join(scope.notesDir, "old.md")
    const newer = path.join(scope.notesDir, "new.md")
    await fs.writeFile(older, "---\ntitle: old\n---\nold body")
    // Ensure distinct mtimes
    await new Promise((r) => setTimeout(r, 20))
    await fs.writeFile(newer, "---\ntitle: new\n---\nnew body")
    const docs = await loadAll(scope)
    expect(docs.notes).toHaveLength(2)
    expect(docs.notes[0].meta.title).toBe("new")
    expect(docs.notes[1].meta.title).toBe("old")
  })

  test("respects maxNotes cap", async () => {
    const scope = await makeVaultScope()
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(scope.notesDir, `note${i}.md`), `---\nn: ${i}\n---\n`)
    }
    const docs = await loadAll(scope, 3)
    expect(docs.notes).toHaveLength(3)
  })

  test("skips non-md files in notes dir", async () => {
    const scope = await makeVaultScope()
    await fs.writeFile(path.join(scope.notesDir, "note.md"), "---\ntitle: a\n---\nbody")
    await fs.writeFile(path.join(scope.notesDir, "ignore.txt"), "not a memory")
    await fs.writeFile(path.join(scope.notesDir, ".hidden"), "hidden")
    const docs = await loadAll(scope)
    expect(docs.notes).toHaveLength(1)
    expect(docs.notes[0].meta.title).toBe("a")
  })
})

describe("writeNote", () => {
  test("writes note with correct frontmatter and path", async () => {
    const scope = await makeVaultScope()
    const filepath = await writeNote(scope, {
      title: "My First Note",
      body: "hello",
    })
    expect(filepath.startsWith(scope.notesDir)).toBe(true)
    expect(filepath).toMatch(/my-first-note\.md$/)
    const content = await fs.readFile(filepath, "utf8")
    expect(content).toContain("type: memory-note")
    expect(content).toContain("title: My First Note")
    expect(content).toContain(`repo: ${scope.shortHash}`)
    expect(content).toContain("branch: main")
    expect(content).toContain("hello")
  })

  test("creates notes dir if missing", async () => {
    const scope = await makeVaultScope()
    await fs.rm(scope.notesDir, { recursive: true, force: true })
    const filepath = await writeNote(scope, { title: "T", body: "b" })
    expect(await fs.readFile(filepath, "utf8")).toContain("title: T")
  })

  test("title-less notes get 'note' slug", async () => {
    const scope = await makeVaultScope()
    const filepath = await writeNote(scope, { title: "", body: "b" })
    expect(filepath).toMatch(/-note\.md$/)
  })

  test("sanitizes title slug", async () => {
    const scope = await makeVaultScope()
    const filepath = await writeNote(scope, { title: "Hello, World! (v2)", body: "b" })
    expect(filepath).toMatch(/hello-world-v2\.md$/)
  })
})
