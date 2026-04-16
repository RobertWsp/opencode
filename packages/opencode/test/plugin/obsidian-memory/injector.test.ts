import { describe, expect, spyOn, test } from "bun:test"
import { formatBlock } from "../../../src/plugin/obsidian-memory/injector"
import type { MemoryDoc, Scope, VaultDocs } from "../../../src/plugin/obsidian-memory/types"

function makeScope(overrides: Partial<Scope> = {}): Scope {
  return {
    vaultRoot: "/tmp/vault",
    basename: "test",
    shortHash: "abc123",
    repoSlug: "test-abc123",
    branchRaw: "main",
    branchSlug: "main",
    repoDir: "/tmp/vault/opencode/repos/test-abc123",
    repoSharedPath: "/tmp/vault/opencode/repos/test-abc123/MEMORY.md",
    branchDir: "/tmp/vault/opencode/repos/test-abc123/branches/main",
    branchSharedPath: "/tmp/vault/opencode/repos/test-abc123/branches/main/MEMORY.md",
    notesDir: "/tmp/vault/opencode/repos/test-abc123/branches/main/notes",
    suggestedDir: "/tmp/vault/opencode/repos/test-abc123/branches/main/suggested",
    systemDir: "/tmp/vault/_system",
    systemSharedPath: "/tmp/vault/_system/MEMORY.md",
    ...overrides,
  }
}

function makeDoc(
  overrides: Partial<MemoryDoc> & { body: string; meta?: Record<string, string> },
): MemoryDoc {
  return {
    path: overrides.path ?? "/tmp/note.md",
    meta: overrides.meta ?? {},
    body: overrides.body,
    mtimeMs: overrides.mtimeMs ?? 0,
    size: overrides.size ?? overrides.body.length,
  }
}

describe("formatBlock", () => {
  test("returns empty string for empty vault", () => {
    const block = formatBlock(makeScope(), { notes: [] }, { maxBytes: 4096 })
    expect(block).toBe("")
  })

  test("includes wrapper tag with shortHash and branchSlug", () => {
    const block = formatBlock(
      makeScope(),
      {
        repoShared: makeDoc({ body: "pinned context" }),
        notes: [],
      },
      { maxBytes: 4096 },
    )
    expect(block).toContain('<memory-block repo="abc123" branch="main"')
    expect(block).toContain("</memory-block>")
  })

  test("includes hash attribute derived from body", () => {
    const block = formatBlock(
      makeScope(),
      { repoShared: makeDoc({ body: "content" }), notes: [] },
      { maxBytes: 4096 },
    )
    expect(block).toMatch(/hash="[0-9a-f]{8}"/)
  })

  test("is byte-identical for identical inputs", () => {
    const docs: VaultDocs = {
      repoShared: makeDoc({ body: "shared content" }),
      notes: [
        makeDoc({
          body: "note body",
          meta: { title: "my note", created: "2026-01-01T00:00:00Z" },
          mtimeMs: 1000,
        }),
      ],
    }
    const b1 = formatBlock(makeScope(), docs, { maxBytes: 4096 })
    const b2 = formatBlock(makeScope(), docs, { maxBytes: 4096 })
    expect(b1).toBe(b2)
    expect(b1.length).toBeGreaterThan(0)
  })

  test("renders shared repo section with heading", () => {
    const block = formatBlock(
      makeScope(),
      { repoShared: makeDoc({ body: "repo memory" }), notes: [] },
      { maxBytes: 4096 },
    )
    expect(block).toContain("## Shared (repo)")
    expect(block).toContain("repo memory")
  })

  test("renders branch shared section with branchSlug in heading", () => {
    const block = formatBlock(
      makeScope({ branchSlug: "feat-x" }),
      { branchShared: makeDoc({ body: "branch memory" }), notes: [] },
      { maxBytes: 4096 },
    )
    expect(block).toContain("## Shared (branch: feat-x)")
  })

  test("renders notes with title and timestamp headings", () => {
    const block = formatBlock(
      makeScope(),
      {
        notes: [
          makeDoc({
            body: "first note body",
            meta: { title: "first", created: "2026-01-01T00:00:00Z" },
          }),
        ],
      },
      { maxBytes: 4096 },
    )
    expect(block).toContain("## Recent Notes")
    expect(block).toContain("### 2026-01-01T00:00:00Z — first")
    expect(block).toContain("first note body")
  })

  test("falls back to filename when title missing", () => {
    const block = formatBlock(
      makeScope(),
      {
        notes: [
          makeDoc({
            body: "body",
            path: "/tmp/notes/my-file.md",
            meta: {},
          }),
        ],
      },
      { maxBytes: 4096 },
    )
    expect(block).toContain("### my-file")
  })

  test("truncates notes when exceeding maxBytes", () => {
    const bigBody = "x".repeat(1000)
    const notes = Array.from({ length: 10 }, (_, i) =>
      makeDoc({
        body: bigBody,
        meta: { title: `note-${i}` },
        mtimeMs: 1000 - i,
      }),
    )
    const blockSmall = formatBlock(makeScope(), { notes }, { maxBytes: 2500 })
    const blockLarge = formatBlock(makeScope(), { notes }, { maxBytes: 20000 })
    expect(blockSmall.length).toBeLessThan(blockLarge.length)
    // Small budget should include fewer notes
    const smallNoteCount = (blockSmall.match(/### /g) || []).length
    const largeNoteCount = (blockLarge.match(/### /g) || []).length
    expect(smallNoteCount).toBeLessThan(largeNoteCount)
  })

  test("does not contain literal 'opencode' string", () => {
    // Guard against the anthropic plugin's /opencode/gi sanitization —
    // our block must never use that literal.
    const block = formatBlock(
      makeScope(),
      {
        repoShared: makeDoc({ body: "shared" }),
        branchShared: makeDoc({ body: "branch" }),
        notes: [makeDoc({ body: "note", meta: { title: "t" } })],
      },
      { maxBytes: 4096 },
    )
    expect(block.toLowerCase()).not.toContain("opencode")
  })

  test("handles all three sections together", () => {
    const block = formatBlock(
      makeScope(),
      {
        repoShared: makeDoc({ body: "repo shared" }),
        branchShared: makeDoc({ body: "branch shared" }),
        notes: [
          makeDoc({
            body: "note body",
            meta: { title: "n1", created: "2026-01-01T00:00:00Z" },
          }),
        ],
      },
      { maxBytes: 4096 },
    )
    expect(block).toContain("## Shared (repo)")
    expect(block).toContain("## Shared (branch:")
    expect(block).toContain("## Recent Notes")
  })

  test("renders _system/ layer as User Preferences section first", () => {
    const block = formatBlock(
      makeScope(),
      {
        systemShared: makeDoc({ body: "user likes pt-BR" }),
        repoShared: makeDoc({ body: "repo ctx" }),
        notes: [],
      },
      { maxBytes: 4096 },
    )
    expect(block).toContain("## User Preferences")
    expect(block).toContain("user likes pt-BR")
    // User Preferences must come before repo
    const userIdx = block.indexOf("## User Preferences")
    const repoIdx = block.indexOf("## Shared (repo)")
    expect(userIdx).toBeGreaterThan(-1)
    expect(repoIdx).toBeGreaterThan(-1)
    expect(userIdx).toBeLessThan(repoIdx)
  })

  test("systemShared alone still produces a block", () => {
    const block = formatBlock(
      makeScope(),
      { systemShared: makeDoc({ body: "just prefs" }), notes: [] },
      { maxBytes: 4096 },
    )
    expect(block).toContain("<memory-block")
    expect(block).toContain("just prefs")
  })
})

describe("formatBlock index style", () => {
  test("emits <memory-index> wrapper instead of <memory-block>", () => {
    const block = formatBlock(
      makeScope(),
      {
        repoShared: makeDoc({
          body: "repo body",
          meta: { title: "Repo Context", description: "Core architecture notes" },
          path: "/tmp/vault/opencode/repos/test-abc123/MEMORY.md",
        }),
        notes: [],
      },
      { maxBytes: 4096 },
      undefined,
      "index",
    )
    expect(block).toContain("<memory-index")
    expect(block).not.toContain("<memory-block")
  })

  test("index entries show title and description, not full body", () => {
    const block = formatBlock(
      makeScope(),
      {
        repoShared: makeDoc({
          body: "full repo body with lots of\ndetails that should NOT appear",
          meta: { title: "Repo Context", description: "Short summary" },
          path: "/tmp/vault/opencode/repos/test-abc123/MEMORY.md",
        }),
        notes: [
          makeDoc({
            body: "long note body that should also not appear in index",
            meta: {
              title: "gotcha-1",
              description: "One liner",
              created: "2026-04-15T12:00:00Z",
            },
            path: "/tmp/vault/opencode/repos/test-abc123/branches/main/notes/a.md",
          }),
        ],
      },
      { maxBytes: 4096 },
      undefined,
      "index",
    )
    expect(block).toContain("Repo Context")
    expect(block).toContain("Short summary")
    expect(block).toContain("gotcha-1")
    expect(block).toContain("One liner")
    // Bodies must NOT be embedded
    expect(block).not.toContain("full repo body with lots of")
    expect(block).not.toContain("long note body")
  })

  test("index is meaningfully smaller than full for same input", () => {
    const bigBody = "x".repeat(500)
    const docs = {
      repoShared: makeDoc({
        body: bigBody,
        meta: { title: "T", description: "D" },
        path: "/tmp/vault/opencode/repos/test-abc123/MEMORY.md",
      }),
      notes: Array.from({ length: 5 }, (_, i) =>
        makeDoc({
          body: bigBody,
          meta: { title: `n${i}`, description: "d", created: "2026-04-15T00:00:00Z" },
          path: `/tmp/vault/opencode/repos/test-abc123/branches/main/notes/${i}.md`,
        }),
      ),
    }
    const full = formatBlock(makeScope(), docs, { maxBytes: 10000 }, undefined, "full")
    const index = formatBlock(makeScope(), docs, { maxBytes: 10000 }, undefined, "index")
    expect(index.length).toBeLessThan(full.length / 3)
  })

  test("index truncates by dropping oldest notes when over budget", () => {
    const docs = {
      notes: Array.from({ length: 30 }, (_, i) =>
        makeDoc({
          body: "body",
          meta: {
            title: `note-${String(i).padStart(2, "0")}`,
            description: "one",
            created: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
          },
          path: `/tmp/vault/opencode/repos/test-abc123/branches/main/notes/${i}.md`,
          mtimeMs: 1000 - i,
        }),
      ),
    }
    const smallBudget = formatBlock(makeScope(), docs, { maxBytes: 600 }, undefined, "index")
    const bigBudget = formatBlock(makeScope(), docs, { maxBytes: 10000 }, undefined, "index")
    expect(smallBudget.length).toBeLessThanOrEqual(700) // small slack for wrapper
    expect(bigBudget.length).toBeGreaterThan(smallBudget.length)
  })

  test("index includes Use /memory show hint", () => {
    const block = formatBlock(
      makeScope(),
      { repoShared: makeDoc({ body: "x", meta: { title: "T" }, path: "/tmp/vault/opencode/repos/test-abc123/MEMORY.md" }), notes: [] },
      { maxBytes: 4096 },
      undefined,
      "index",
    )
    expect(block).toContain("Use /memory show")
  })

  test("index hides fully-stale memories", () => {
    const doc = makeDoc({
      body: "x",
      meta: { title: "T" },
      path: "/tmp/vault/opencode/repos/test-abc123/MEMORY.md",
    })
    const refHealth = new Map([
      [
        doc.path,
        {
          refs: [],
          anyValid: false,
          allBroken: true,
          brokenCount: 1,
        },
      ],
    ])
    const block = formatBlock(
      makeScope(),
      { repoShared: doc, notes: [] },
      { maxBytes: 4096 },
      refHealth,
      "index",
    )
    expect(block).toBe("")
  })
})

describe("formatBlock progressive style (F4.2)", () => {
  test("shared docs rendered in full", () => {
    const sharedBody = "Full shared body content\nWith multiple lines"
    const block = formatBlock(
      makeScope(),
      {
        repoShared: makeDoc({
          body: sharedBody,
          meta: { title: "Repo Context", description: "Short" },
          path: "/tmp/vault/opencode/repos/test-abc123/MEMORY.md",
        }),
        notes: [],
      },
      { maxBytes: 4096 },
      undefined,
      "progressive",
    )
    expect(block).toContain(sharedBody.trim())
    expect(block).toContain("## Shared (repo)")
  })

  test("notes rendered as compact index, full body excluded", () => {
    const nBody = "This is the full note body that must not appear"
    const block = formatBlock(
      makeScope(),
      {
        notes: [
          makeDoc({
            body: nBody,
            meta: {
              title: "My Note",
              description: "Brief description",
              "memory-kind": "gotcha",
              importance: "0.9",
            },
            path: "/tmp/vault/opencode/repos/test-abc123/branches/main/notes/my-note.md",
          }),
        ],
      },
      { maxBytes: 4096 },
      undefined,
      "progressive",
    )
    expect(block).toContain("My Note")
    expect(block).toContain("Brief description")
    expect(block).not.toContain(nBody)
  })

  test("each note entry includes show: <relpath> hint", () => {
    const block = formatBlock(
      makeScope(),
      {
        notes: [
          makeDoc({
            body: "note body",
            meta: { title: "My Note", description: "desc" },
            path: "/tmp/vault/opencode/repos/test-abc123/branches/main/notes/my-note.md",
          }),
        ],
      },
      { maxBytes: 4096 },
      undefined,
      "progressive",
    )
    expect(block).toContain("show:")
    expect(block).toContain("opencode/repos/test-abc123/branches/main/notes/my-note.md")
  })

  test("total bytes less than full mode for same input", () => {
    const big = "x".repeat(500)
    const docs = {
      repoShared: makeDoc({
        body: big,
        meta: { title: "T", description: "D" },
        path: "/tmp/vault/opencode/repos/test-abc123/MEMORY.md",
      }),
      notes: Array.from({ length: 5 }, (_, i) =>
        makeDoc({
          body: big,
          meta: { title: `note-${i}`, description: "d" },
          path: `/tmp/vault/opencode/repos/test-abc123/branches/main/notes/${i}.md`,
        }),
      ),
    }
    const full = formatBlock(makeScope(), docs, { maxBytes: 10000 }, undefined, "full")
    const progressive = formatBlock(makeScope(), docs, { maxBytes: 10000 }, undefined, "progressive")
    expect(progressive.length).toBeLessThan(full.length)
  })

  test("empty notes → only shared docs, no Notes Index section", () => {
    const block = formatBlock(
      makeScope(),
      { repoShared: makeDoc({ body: "repo content" }), notes: [] },
      { maxBytes: 4096 },
      undefined,
      "progressive",
    )
    expect(block).toContain("repo content")
    expect(block).not.toContain("Notes Index")
    expect(block).not.toContain("Use /memory show")
  })
})

describe("formatBlock cache optimization (F4.3)", () => {
  test("shared docs appear before notes in full mode", () => {
    const block = formatBlock(
      makeScope(),
      {
        repoShared: makeDoc({ body: "stable shared content" }),
        notes: [makeDoc({ body: "volatile note", meta: { title: "n1" } })],
      },
      { maxBytes: 4096 },
    )
    const si = block.indexOf("stable shared content")
    const ni = block.indexOf("volatile note")
    expect(si).toBeGreaterThan(-1)
    expect(ni).toBeGreaterThan(-1)
    expect(si).toBeLessThan(ni)
  })

  test("shared docs appear before notes in progressive mode", () => {
    const block = formatBlock(
      makeScope(),
      {
        repoShared: makeDoc({ body: "stable shared content" }),
        notes: [
          makeDoc({
            body: "volatile note body",
            meta: { title: "n1", description: "desc" },
            path: "/tmp/vault/opencode/repos/test-abc123/branches/main/notes/n1.md",
          }),
        ],
      },
      { maxBytes: 4096 },
      undefined,
      "progressive",
    )
    const si = block.indexOf("stable shared content")
    const ni = block.indexOf("n1")
    expect(si).toBeGreaterThan(-1)
    expect(ni).toBeGreaterThan(-1)
    expect(si).toBeLessThan(ni)
  })

  test("warns when maxBytes < 4096", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    formatBlock(makeScope(), { repoShared: makeDoc({ body: "x" }), notes: [] }, { maxBytes: 2000 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("4096"))
    warn.mockRestore()
  })

  test("no warning when maxBytes >= 4096", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    formatBlock(makeScope(), { repoShared: makeDoc({ body: "x" }), notes: [] }, { maxBytes: 4096 })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
