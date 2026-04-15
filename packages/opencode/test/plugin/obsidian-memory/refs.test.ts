import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { parseRefs, verifyDocRefs, verifyRef } from "../../../src/plugin/obsidian-memory/refs"
import type { MemoryDoc } from "../../../src/plugin/obsidian-memory/types"

const tempDirs: string[] = []

async function makeWorktree(
  files: Record<string, string>,
): Promise<{ worktree: string }> {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "omem-refs-wt-"))
  tempDirs.push(worktree)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(worktree, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, "utf8")
  }
  return { worktree }
}

function makeDoc(overrides: Partial<MemoryDoc> & { meta?: Record<string, string>; body?: string }): MemoryDoc {
  return {
    path: "/tmp/note.md",
    meta: overrides.meta ?? {},
    body: overrides.body ?? "",
    mtimeMs: 0,
    size: 0,
  }
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("parseRefs", () => {
  test("parses refs from frontmatter comma-separated", () => {
    const doc = makeDoc({ meta: { refs: "src/foo.ts:42-58,src/bar.ts" } })
    const refs = parseRefs(doc)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toEqual({ path: "src/foo.ts", lines: [42, 58] })
    expect(refs[1]).toEqual({ path: "src/bar.ts" })
  })

  test("parses single line ref without range", () => {
    const doc = makeDoc({ meta: { refs: "README.md" } })
    const refs = parseRefs(doc)
    expect(refs).toEqual([{ path: "README.md" }])
  })

  test("parses refs from body Refs: section", () => {
    const body = [
      "Some context here.",
      "",
      "Refs:",
      "- src/foo.ts:10-20",
      "- src/bar.ts",
      "- @src/baz.ts:5",
      "",
      "More prose.",
    ].join("\n")
    const refs = parseRefs(makeDoc({ body }))
    expect(refs).toHaveLength(3)
    expect(refs[0]).toEqual({ path: "src/foo.ts", lines: [10, 20] })
    expect(refs[1]).toEqual({ path: "src/bar.ts" })
    expect(refs[2]).toEqual({ path: "src/baz.ts", lines: [5, 5] })
  })

  test("dedupes repeated refs", () => {
    const doc = makeDoc({
      meta: { refs: "src/a.ts,src/a.ts" },
      body: "Refs:\n- src/a.ts\n",
    })
    const refs = parseRefs(doc)
    expect(refs).toHaveLength(1)
  })

  test("ignores comment lines and empty input", () => {
    const doc = makeDoc({
      body: "Refs:\n# comment\n\n",
    })
    expect(parseRefs(doc)).toEqual([])
  })

  test("handles no refs at all", () => {
    expect(parseRefs(makeDoc({ body: "just prose" }))).toEqual([])
  })
})

describe("verifyRef", () => {
  test("returns valid when file exists and no line range", async () => {
    const { worktree } = await makeWorktree({ "src/foo.ts": "content\n" })
    const status = await verifyRef(worktree, { path: "src/foo.ts" })
    expect(status.valid).toBe(true)
    expect(status.exists).toBe(true)
  })

  test("returns invalid when file missing", async () => {
    const { worktree } = await makeWorktree({})
    const status = await verifyRef(worktree, { path: "src/foo.ts" })
    expect(status.valid).toBe(false)
    expect(status.exists).toBe(false)
    expect(status.reason).toContain("missing")
  })

  test("returns valid when line range fits", async () => {
    const { worktree } = await makeWorktree({
      "src/foo.ts": Array(100).fill("line").join("\n"),
    })
    const status = await verifyRef(worktree, { path: "src/foo.ts", lines: [10, 20] })
    expect(status.valid).toBe(true)
  })

  test("returns invalid when line range exceeds file length", async () => {
    const { worktree } = await makeWorktree({
      "src/foo.ts": "only\ntwo\n",
    })
    const status = await verifyRef(worktree, { path: "src/foo.ts", lines: [50, 100] })
    expect(status.valid).toBe(false)
    expect(status.reason).toContain("exceeds")
  })

  test("rejects path traversal", async () => {
    const { worktree } = await makeWorktree({})
    const status = await verifyRef(worktree, { path: "../../etc/passwd" })
    expect(status.valid).toBe(false)
    expect(status.reason).toContain("escapes worktree")
  })
})

describe("verifyDocRefs", () => {
  test("empty refs → anyValid=true, allBroken=false", async () => {
    const { worktree } = await makeWorktree({})
    const health = await verifyDocRefs(worktree, makeDoc({}))
    expect(health.anyValid).toBe(true)
    expect(health.allBroken).toBe(false)
    expect(health.brokenCount).toBe(0)
  })

  test("all refs broken → allBroken=true", async () => {
    const { worktree } = await makeWorktree({})
    const doc = makeDoc({ meta: { refs: "src/a.ts,src/b.ts" } })
    const health = await verifyDocRefs(worktree, doc)
    expect(health.allBroken).toBe(true)
    expect(health.anyValid).toBe(false)
    expect(health.brokenCount).toBe(2)
  })

  test("partial broken → anyValid=true, allBroken=false", async () => {
    const { worktree } = await makeWorktree({ "src/a.ts": "x" })
    const doc = makeDoc({ meta: { refs: "src/a.ts,src/missing.ts" } })
    const health = await verifyDocRefs(worktree, doc)
    expect(health.anyValid).toBe(true)
    expect(health.allBroken).toBe(false)
    expect(health.brokenCount).toBe(1)
  })

  test("all refs valid → allBroken=false, brokenCount=0", async () => {
    const { worktree } = await makeWorktree({
      "src/a.ts": "x\n",
      "src/b.ts": "y\n",
    })
    const doc = makeDoc({ meta: { refs: "src/a.ts,src/b.ts" } })
    const health = await verifyDocRefs(worktree, doc)
    expect(health.anyValid).toBe(true)
    expect(health.allBroken).toBe(false)
    expect(health.brokenCount).toBe(0)
  })
})
