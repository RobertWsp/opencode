import { describe, it, expect } from "bun:test"
import { rrfMerge } from "../rrf"

describe("rrfMerge", () => {
  it("empty rankings → empty map", () => {
    expect(rrfMerge([]).size).toBe(0)
  })

  it("single ranking preserves relative order", () => {
    const r = new Map([["a", 0.9], ["b", 0.5], ["c", 0.1]])
    const out = rrfMerge([r])
    const scores = [...out.entries()].sort((x, y) => y[1] - x[1])
    expect(scores.map(([id]) => id)).toEqual(["a", "b", "c"])
  })

  it("cross-ranking presence beats single-ranking dominance", () => {
    const rank0Only = new Map([["top", 1.0], ["cross", 0.5], ["other", 0.2]])
    const rank1Only = new Map([["cross", 0.8], ["noise", 0.3]])
    const out = rrfMerge([rank0Only, rank1Only])
    expect(out.get("cross")!).toBeGreaterThan(out.get("top")!)
  })
})
