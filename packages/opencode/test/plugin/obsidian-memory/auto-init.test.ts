import { describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import {
  buildInitNotes,
  detectProjectFiles,
  markInitDone,
  shouldAutoInit,
} from "../../../src/plugin/obsidian-memory/auto-init"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

function makeScope(vaultRoot: string): Scope {
  const repoDir = path.join(vaultRoot, "opencode", "repos", "test-abc123")
  const branchDir = path.join(repoDir, "branches", "main")
  return {
    vaultRoot,
    basename: "test",
    shortHash: "abc123",
    repoSlug: "test-abc123",
    branchRaw: "main",
    branchSlug: "main",
    repoDir,
    repoSharedPath: path.join(repoDir, "MEMORY.md"),
    branchDir,
    branchSharedPath: path.join(branchDir, "MEMORY.md"),
    notesDir: path.join(branchDir, "notes"),
    suggestedDir: path.join(branchDir, "suggested"),
    systemDir: path.join(vaultRoot, "_system"),
    systemSharedPath: path.join(vaultRoot, "_system", "MEMORY.md"),
  }
}

describe("detectProjectFiles", () => {
  test("finds existing project files from list", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "README.md"), "# Hello")
    await Bun.write(path.join(tmp.path, "package.json"), '{"name":"test"}')
    const files = await detectProjectFiles(tmp.path)
    const names = files.map((f) => f.name)
    expect(names).toContain("README.md")
    expect(names).toContain("package.json")
    expect(files.find((f) => f.name === "README.md")?.content).toBe("# Hello")
  })

  test("returns empty array for dir with no known files", async () => {
    await using tmp = await tmpdir()
    const files = await detectProjectFiles(tmp.path)
    expect(files).toEqual([])
  })
})

describe("shouldAutoInit", () => {
  test("returns true when vault has zero notes AND zero shared docs", async () => {
    await using tmp = await tmpdir()
    const scope = makeScope(tmp.path)
    expect(await shouldAutoInit(scope, tmp.path)).toBe(true)
  })

  test("returns false when vault has notes", async () => {
    await using tmp = await tmpdir()
    const scope = makeScope(tmp.path)
    await fs.mkdir(scope.notesDir, { recursive: true })
    await Bun.write(
      path.join(scope.notesDir, "note.md"),
      "---\ntype: memory-note\nmemory-kind: fact\ntitle: existing\n---\nBody",
    )
    expect(await shouldAutoInit(scope, tmp.path)).toBe(false)
  })

  test("returns false when .init flag exists", async () => {
    await using tmp = await tmpdir()
    const scope = makeScope(tmp.path)
    await fs.mkdir(scope.branchDir, { recursive: true })
    await Bun.write(path.join(scope.branchDir, ".init"), "")
    expect(await shouldAutoInit(scope, tmp.path)).toBe(false)
  })
})

describe("buildInitNotes", () => {
  test("generates notes from project file contents", () => {
    const files = [
      { name: "README.md", content: "# My Project\n\nThis is a test project." },
      {
        name: "package.json",
        content: '{"name":"my-project","description":"A test","dependencies":{"react":"^18.0.0"}}',
      },
    ]
    const notes = buildInitNotes(files)
    expect(notes.length).toBeGreaterThan(0)
    const readme = notes.find((n) => n.kind === "architecture")
    expect(readme).toBeDefined()
    expect(readme?.body).toContain("My Project")
    const pkg = notes.find((n) => n.name === "package.json")
    expect(pkg?.body).toContain("react")
  })

  test("limits output to reasonable size (~2KB per note)", () => {
    const large = "x".repeat(20_000)
    const files = [{ name: "README.md", content: large }]
    const notes = buildInitNotes(files)
    for (const n of notes) {
      expect(n.body.length).toBeLessThanOrEqual(2048)
    }
  })
})

describe("markInitDone", () => {
  test("creates .init flag file", async () => {
    await using tmp = await tmpdir()
    const scope = makeScope(tmp.path)
    await markInitDone(scope)
    expect(await Bun.file(path.join(scope.branchDir, ".init")).exists()).toBe(true)
  })
})
