import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import * as Commands from "../../../src/plugin/obsidian-memory/commands"
import { writeNote } from "../../../src/plugin/obsidian-memory/vault"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-suggest-"))
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

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("suggest mode commands", () => {
  test("/memory suggested — empty returns friendly message", async () => {
    const scope = await makeScope()
    const result = await Commands.suggested(scope)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("no pending suggestions")
  })

  test("/memory suggested — lists pending files", async () => {
    const scope = await makeScope()
    await writeNote(scope, {
      title: "candidate auth gotcha",
      body: "some content",
      meta: { importance: "0.8" },
      targetDir: scope.suggestedDir,
      skipCommit: true,
    })
    const result = await Commands.suggested(scope)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("1 pending")
    expect(result.text).toContain("candidate auth gotcha")
    expect(result.text).toContain("0.8")
  })

  test("/memory approve — promotes file to notesDir and returns relative path", async () => {
    const scope = await makeScope()
    const suggested = await writeNote(scope, {
      title: "approve me",
      body: "important content",
      targetDir: scope.suggestedDir,
      skipCommit: true,
    })
    const filename = path.basename(suggested)

    const result = await Commands.approve(scope, filename)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("approved")

    // Original should be gone
    await expect(fs.access(suggested)).rejects.toThrow()
    // New file should exist in notesDir
    const promoted = path.join(scope.notesDir, filename)
    const exists = await fs
      .stat(promoted)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  test("/memory approve — error on missing file", async () => {
    const scope = await makeScope()
    const result = await Commands.approve(scope, "does-not-exist.md")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("not found")
  })

  test("/memory approve — empty filename", async () => {
    const scope = await makeScope()
    const result = await Commands.approve(scope, "")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("usage")
  })

  test("/memory approve — rejects path traversal via basename()", async () => {
    const scope = await makeScope()
    const result = await Commands.approve(scope, "../../etc/passwd")
    expect(result.ok).toBe(false)
    // Basename strips the traversal and looks for plain "passwd" which won't exist
    expect(result.text).toContain("not found")
  })

  test("/memory reject — deletes suggestion", async () => {
    const scope = await makeScope()
    const suggested = await writeNote(scope, {
      title: "throw away",
      body: "noise",
      targetDir: scope.suggestedDir,
      skipCommit: true,
    })
    const filename = path.basename(suggested)
    const result = await Commands.reject(scope, filename)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("rejected")
    await expect(fs.access(suggested)).rejects.toThrow()
  })

  test("/memory reject — error on missing", async () => {
    const scope = await makeScope()
    const result = await Commands.reject(scope, "ghost.md")
    expect(result.ok).toBe(false)
  })
})
