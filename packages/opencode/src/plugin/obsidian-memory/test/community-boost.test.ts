import { describe, test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { VaultIndex } from "../vault-index"

const dirs: string[] = []
function mkDir() {
  const d = mkdtempSync(path.join(tmpdir(), "community-boost-"))
  dirs.push(d)
  return d
}

describe("communityNeighbors", () => {
  test("returns neighbors in same community ordered by recency", () => {
    const dir = mkDir()
    const idx = new VaultIndex(dir)
    idx.open()
    const map = new Map([["/a.md", 0], ["/b.md", 0], ["/c.md", 0], ["/d.md", 1]])
    idx.upsertCommunities(map)
    const neighbors = idx.communityNeighbors("/a.md", 0, 5)
    expect(neighbors).not.toContain("/a.md")
    expect(neighbors).not.toContain("/d.md")
    expect(neighbors.length).toBeLessThanOrEqual(2)
    idx.close()
    rmSync(dir, { recursive: true })
  })
})
