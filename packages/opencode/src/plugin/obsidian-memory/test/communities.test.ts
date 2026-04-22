import { describe, test, expect } from "bun:test"
import { buildCommunities } from "../communities"
import type { MemoryEntry } from "../types"

function entry(name: string, links: string[] = []): MemoryEntry {
  return {
    doc: {
      path: `/vault/${name}.md`,
      meta: {},
      body: "",
      mtimeMs: Date.now(),
      size: 0,
    },
    kind: "fact" as const,
    title: name,
    description: "",
    tags: [],
    links,
    importance: 0.5,
    created: new Date().toISOString(),
    validFrom: new Date().toISOString(),
    validUntil: null,
    supersededBy: null,
  }
}

describe("buildCommunities", () => {
  test("returns empty map for empty input", () => {
    expect(buildCommunities([])).toEqual(new Map())
  })

  test("two disjoint clusters of 10 nodes each → exactly 2 community IDs", () => {
    const clusterA = [
      entry("a0", ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]),
      ...Array.from({ length: 9 }, (_, i) => entry(`a${i + 1}`, ["a0"])),
    ]
    const clusterB = [
      entry("b0", ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"]),
      ...Array.from({ length: 9 }, (_, i) => entry(`b${i + 1}`, ["b0"])),
    ]
    const all = [...clusterA, ...clusterB]
    const result = buildCommunities(all)

    expect(result.size).toBe(20)
    const ids = new Set(result.values())
    expect(ids.size).toBe(2)

    const aIds = new Set(clusterA.map((e) => result.get(e.doc.path)))
    expect(aIds.size).toBe(1)

    const bIds = new Set(clusterB.map((e) => result.get(e.doc.path)))
    expect(bIds.size).toBe(1)

    expect([...aIds][0]).not.toBe([...bIds][0])
  })

  test("single node returns map with one entry", () => {
    const result = buildCommunities([entry("solo")])
    expect(result.size).toBe(1)
  })
})
