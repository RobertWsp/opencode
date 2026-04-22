import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { VaultIndex } from "../vault-index"

const dirs: string[] = []

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-idx-"))
  dirs.push(dir)
  const idx = new VaultIndex(dir)
  idx.open()
  return idx
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe("communities", () => {
  test("upsertCommunities + getCommunity", () => {
    const idx = setup()
    const map = new Map([
      ["/vault/a.md", 0],
      ["/vault/b.md", 0],
      ["/vault/c.md", 1],
    ])
    idx.upsertCommunities(map)
    expect(idx.getCommunity("/vault/a.md")).toBe(0)
    expect(idx.getCommunity("/vault/c.md")).toBe(1)
    expect(idx.getCommunity("/vault/missing.md")).toBeNull()
    idx.close()
  })

  test("communityStats", () => {
    const idx = setup()
    const map = new Map([
      ["/a.md", 0],
      ["/b.md", 0],
      ["/c.md", 0],
      ["/d.md", 1],
      ["/e.md", 1],
      ["/f.md", 2],
    ])
    idx.upsertCommunities(map)
    const stats = idx.communityStats()
    expect(stats.total).toBe(3)
    expect(stats.largest).toBe(3)
    expect(stats.isolates).toBe(1)
    idx.close()
  })

  test("lastCommunityBuild returns null when empty", () => {
    const idx = setup()
    expect(idx.lastCommunityBuild()).toBeNull()
    idx.close()
  })

  test("noteCount returns 0 for empty index", () => {
    const idx = setup()
    expect(idx.noteCount()).toBe(0)
    idx.close()
  })

  test("lastMemoryWrite returns null for empty index", () => {
    const idx = setup()
    expect(idx.lastMemoryWrite()).toBeNull()
    idx.close()
  })

  test("upsertCommunities replaces previous data", () => {
    const idx = setup()
    idx.upsertCommunities(new Map([["/a.md", 0], ["/b.md", 1]]))
    idx.upsertCommunities(new Map([["/c.md", 0]]))
    expect(idx.getCommunity("/a.md")).toBeNull()
    expect(idx.getCommunity("/c.md")).toBe(0)
    idx.close()
  })
})
