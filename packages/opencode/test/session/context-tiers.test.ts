import { describe, expect, test } from "bun:test"
import { ContextTiers } from "../../src/session/context-tiers"

describe("session.context-tiers", () => {
  describe("DEFAULTS", () => {
    test("has correct values", () => {
      expect(ContextTiers.DEFAULTS.tier1Max).toBe(8000)
      expect(ContextTiers.DEFAULTS.tier2Max).toBe(4000)
      expect(ContextTiers.DEFAULTS.tier3Max).toBe(6000)
    })
  })

  describe("allocate", () => {
    test("returns all content when within budget", () => {
      const content = ["a".repeat(40), "b".repeat(40), "c".repeat(40)]
      expect(ContextTiers.allocate(content, 1)).toEqual(content)
    })

    test("trims content to fit budget", () => {
      const cfg = { tier1Max: 10, tier2Max: 4000, tier3Max: 6000 }
      const content = ["a".repeat(40), "b".repeat(40)]
      expect(ContextTiers.allocate(content, 1, cfg)).toEqual(["a".repeat(40)])
    })

    test("returns empty for zero budget", () => {
      const cfg = { tier1Max: 0, tier2Max: 4000, tier3Max: 6000 }
      expect(ContextTiers.allocate(["hello"], 1, cfg)).toEqual([])
    })
  })

  describe("total", () => {
    test("returns sum of all tier budgets", () => {
      expect(ContextTiers.total()).toBe(18000)
    })
  })

  describe("remaining", () => {
    test("calculates correctly with no usage", () => {
      expect(ContextTiers.remaining({ tier1: 0, tier2: 0, tier3: 0 })).toBe(18000)
    })

    test("handles partial usage", () => {
      expect(ContextTiers.remaining({ tier1: 1000, tier2: 500, tier3: 200 })).toBe(16300)
    })
  })

  describe("custom config", () => {
    test("overrides defaults", () => {
      const cfg = { tier1Max: 100, tier2Max: 200, tier3Max: 300 }
      expect(ContextTiers.total(cfg)).toBe(600)
      expect(ContextTiers.remaining({ tier1: 50, tier2: 100, tier3: 150 }, cfg)).toBe(300)
    })
  })
})
