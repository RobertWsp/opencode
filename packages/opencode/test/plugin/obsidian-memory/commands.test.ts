import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import * as Commands from "../../../src/plugin/obsidian-memory/commands"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-cmd-"))
  tempDirs.push(vaultRoot)
  const repoSlug = "test-abc123"
  const branchSlug = "main"
  const repoDir = path.join(vaultRoot, "opencode", "repos", repoSlug)
  const branchDir = path.join(repoDir, "branches", branchSlug)
  const notesDir = path.join(branchDir, "notes")
  await fs.mkdir(notesDir, { recursive: true })
  const systemDir = path.join(vaultRoot, "_system")
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

function fakeClient(messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>) {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  }
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("Commands.save", () => {
  test("rejects empty title", async () => {
    const scope = await makeScope()
    const client = fakeClient([])
    const result = await Commands.save(scope, "", "ses_x", client)
    expect(result.ok).toBe(false)
    expect(result.text).toContain("usage")
  })

  test("writes note with extracted user and assistant text", async () => {
    const scope = await makeScope()
    const client = fakeClient([
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hi there" }] },
    ])
    const result = await Commands.save(scope, "greeting", "ses_x", client)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("saved →")
    // Find the written file
    const entries = await fs.readdir(scope.notesDir)
    expect(entries.length).toBe(1)
    const content = await fs.readFile(path.join(scope.notesDir, entries[0]), "utf8")
    expect(content).toContain("title: greeting")
    expect(content).toContain("hello")
    expect(content).toContain("hi there")
  })

  test("survives messages-fetch failure", async () => {
    const scope = await makeScope()
    const failingClient = {
      session: {
        messages: async () => {
          throw new Error("network down")
        },
      },
    }
    const result = await Commands.save(scope, "t", "ses_x", failingClient)
    expect(result.ok).toBe(true)
    const entries = await fs.readdir(scope.notesDir)
    expect(entries.length).toBe(1)
    const content = await fs.readFile(path.join(scope.notesDir, entries[0]), "utf8")
    expect(content).toContain("network down")
  })
})

describe("Commands.list", () => {
  test("reports empty vault gracefully", async () => {
    const scope = await makeScope()
    const result = await Commands.list(scope)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("no memories yet")
  })

  test("lists shared + notes with relative paths", async () => {
    const scope = await makeScope()
    await fs.writeFile(scope.repoSharedPath, "# repo")
    await fs.writeFile(scope.branchSharedPath, "# branch")
    await fs.writeFile(path.join(scope.notesDir, "a.md"), "note a")
    await fs.writeFile(path.join(scope.notesDir, "b.md"), "note b")
    const result = await Commands.list(scope)
    expect(result.text).toContain("SHARED (repo)")
    expect(result.text).toContain("SHARED (branch)")
    expect(result.text).toContain("NOTE")
    expect(result.text).toContain("a.md")
    expect(result.text).toContain("b.md")
  })

  test("includes scope header", async () => {
    const scope = await makeScope()
    const result = await Commands.list(scope)
    expect(result.text).toContain("repo=abc123")
    expect(result.text).toContain("branch=main")
  })
})

describe("Commands.show", () => {
  test("rejects empty path", async () => {
    const scope = await makeScope()
    const result = await Commands.show(scope, "")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("usage")
  })

  test("rejects path traversal with ../", async () => {
    const scope = await makeScope()
    const result = await Commands.show(scope, "../../etc/passwd")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("escapes vault")
  })

  test("rejects absolute path outside vault", async () => {
    const scope = await makeScope()
    const result = await Commands.show(scope, "/etc/passwd")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("escapes vault")
  })

  test("reads a valid file within vault", async () => {
    const scope = await makeScope()
    await fs.writeFile(scope.repoSharedPath, "hello world")
    const relPath = path.relative(scope.vaultRoot, scope.repoSharedPath)
    const result = await Commands.show(scope, relPath)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("hello world")
  })

  test("returns error for missing file", async () => {
    const scope = await makeScope()
    const result = await Commands.show(scope, "opencode/repos/test-abc123/does-not-exist.md")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("not found")
  })
})
