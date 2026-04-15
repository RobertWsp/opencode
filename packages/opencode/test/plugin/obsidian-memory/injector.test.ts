import { describe, expect, test } from "bun:test"
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
})
