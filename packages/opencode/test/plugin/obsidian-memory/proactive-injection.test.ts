import { describe, expect, test } from "bun:test"
import { __internal } from "../../../src/plugin/obsidian-memory/index"
import type { MemoryDoc } from "../../../src/plugin/obsidian-memory/types"

const { filterProactive } = __internal

function doc(p: string, meta: Record<string, string> = {}, body = ""): MemoryDoc {
  return { path: p, meta, body, mtimeMs: Date.now(), size: body.length }
}

describe("filterProactive", () => {
  test("gotcha with matching ref is included", () => {
    const n = doc("/v/notes/g.md", { "memory-kind": "gotcha", refs: "src/auth.ts" })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([n])
  })

  test("episode with matching ref is included", () => {
    const n = doc("/v/notes/e.md", { "memory-kind": "episode", refs: "src/auth.ts" })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([n])
  })

  test("fact kind is NOT included even with matching ref", () => {
    const n = doc("/v/notes/f.md", { "memory-kind": "fact", refs: "src/auth.ts" })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([])
  })

  test("decision kind is NOT included", () => {
    const n = doc("/v/notes/d.md", { "memory-kind": "decision", refs: "src/auth.ts" })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([])
  })

  test("skill kind is NOT included", () => {
    const n = doc("/v/notes/s.md", { "memory-kind": "skill", refs: "src/auth.ts" })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([])
  })

  test("convention kind is NOT included", () => {
    const n = doc("/v/notes/c.md", { "memory-kind": "convention", refs: "src/auth.ts" })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([])
  })

  test("gotcha with no matching ref is excluded", () => {
    const n = doc("/v/notes/g.md", { "memory-kind": "gotcha", refs: "src/other.ts" })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([])
  })

  test("returns empty when activeFiles is empty", () => {
    const n = doc("/v/notes/g.md", { "memory-kind": "gotcha", refs: "src/auth.ts" })
    expect(filterProactive([n], new Set())).toEqual([])
  })

  test("returns empty when notes is empty", () => {
    expect(filterProactive([], new Set(["src/auth.ts"]))).toEqual([])
  })

  test("matches when one of multiple refs matches", () => {
    const n = doc("/v/notes/g.md", {
      "memory-kind": "gotcha",
      refs: "src/auth.ts,src/config.ts",
    })
    expect(filterProactive([n], new Set(["src/config.ts"]))).toEqual([n])
  })

  test("trims whitespace in refs", () => {
    const n = doc("/v/notes/g.md", {
      "memory-kind": "gotcha",
      refs: "src/auth.ts, src/config.ts",
    })
    expect(filterProactive([n], new Set(["src/config.ts"]))).toEqual([n])
  })

  test("matches multiple gotchas across multiple active files", () => {
    const a = doc("/v/notes/a.md", { "memory-kind": "gotcha", refs: "src/auth.ts" })
    const b = doc("/v/notes/b.md", { "memory-kind": "gotcha", refs: "src/db.ts" })
    const c = doc("/v/notes/c.md", { "memory-kind": "gotcha", refs: "src/unrelated.ts" })
    const result = filterProactive([a, b, c], new Set(["src/auth.ts", "src/db.ts"]))
    expect(result).toEqual([a, b])
  })

  test("excludes invalidated entries (valid_until in the past)", () => {
    const n = doc("/v/notes/g.md", {
      "memory-kind": "gotcha",
      refs: "src/auth.ts",
      valid_until: "2000-01-01T00:00:00Z",
    })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([])
  })

  test("includes entries with valid_until in the future", () => {
    const n = doc("/v/notes/g.md", {
      "memory-kind": "gotcha",
      refs: "src/auth.ts",
      valid_until: "2099-01-01T00:00:00Z",
    })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([n])
  })

  test("gotcha without refs field is excluded", () => {
    const n = doc("/v/notes/g.md", { "memory-kind": "gotcha" })
    expect(filterProactive([n], new Set(["src/auth.ts"]))).toEqual([])
  })

  test("does not match partial path segments", () => {
    const n = doc("/v/notes/g.md", { "memory-kind": "gotcha", refs: "src/auth.ts" })
    expect(filterProactive([n], new Set(["src/auth"])) ).toEqual([])
  })
})
