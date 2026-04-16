import { describe, test, expect } from "bun:test"
import { Tiering } from "../../src/agent/tiering"

describe("Tiering.Tier", () => {
  test("validates correct values", () => {
    for (const v of ["quality", "balanced", "budget", "adaptive", "inherit"] as const) {
      expect(Tiering.Tier.safeParse(v).success).toBe(true)
    }
  })

  test("rejects invalid values", () => {
    expect(Tiering.Tier.safeParse("premium").success).toBe(false)
    expect(Tiering.Tier.safeParse("").success).toBe(false)
    expect(Tiering.Tier.safeParse("QUALITY").success).toBe(false)
  })
})

describe("Tiering.resolve", () => {
  test("returns correct model for quality + anthropic", () => {
    const result = Tiering.resolve("quality", "anthropic")
    expect(result.providerID).toBe("anthropic")
    expect(result.modelID).toBe(Tiering.DEFAULTS.quality.anthropic)
  })

  test("returns correct model for balanced + openai", () => {
    const result = Tiering.resolve("balanced", "openai")
    expect(result.providerID).toBe("openai")
    expect(result.modelID).toBe(Tiering.DEFAULTS.balanced.openai)
  })

  test("falls back to balanced for adaptive tier", () => {
    const result = Tiering.resolve("adaptive", "anthropic")
    expect(result.modelID).toBe(Tiering.DEFAULTS.balanced.anthropic)
  })

  test("falls back to balanced for inherit tier", () => {
    const result = Tiering.resolve("inherit", "google")
    expect(result.modelID).toBe(Tiering.DEFAULTS.balanced.google)
  })

  test("uses overrides when provided", () => {
    const overrides = {
      ...Tiering.DEFAULTS,
      quality: { anthropic: "custom-model" },
    }
    const result = Tiering.resolve("quality", "anthropic", overrides)
    expect(result.modelID).toBe("custom-model")
  })

  test("falls back to balanced override when tier has no match", () => {
    const overrides = {
      ...Tiering.DEFAULTS,
      balanced: { anthropic: "override-balanced" },
    }
    const result = Tiering.resolve("adaptive", "anthropic", overrides)
    expect(result.modelID).toBe("override-balanced")
  })
})

describe("Tiering.adaptive", () => {
  test("returns budget for small tasks", () => {
    expect(Tiering.adaptive({ tokens: 100, tools: 2, files: 1 })).toBe("budget")
    expect(Tiering.adaptive({ tokens: 0, tools: 0, files: 0 })).toBe("budget")
  })

  test("returns balanced for medium tasks by tools", () => {
    expect(Tiering.adaptive({ tokens: 1000, tools: 11, files: 3 })).toBe("balanced")
  })

  test("returns balanced for medium tasks by files", () => {
    expect(Tiering.adaptive({ tokens: 1000, tools: 2, files: 6 })).toBe("balanced")
  })

  test("returns quality for large tasks by tokens", () => {
    expect(Tiering.adaptive({ tokens: 50001, tools: 2, files: 1 })).toBe("quality")
  })

  test("returns quality for large tasks by files", () => {
    expect(Tiering.adaptive({ tokens: 100, tools: 2, files: 16 })).toBe("quality")
  })
})

describe("Tiering.fromParent", () => {
  test("returns parent tier for inherit", () => {
    expect(Tiering.fromParent("inherit", "quality")).toBe("quality")
    expect(Tiering.fromParent("inherit", "budget")).toBe("budget")
    expect(Tiering.fromParent("inherit", "balanced")).toBe("balanced")
  })

  test("returns balanced when parent is undefined for inherit", () => {
    expect(Tiering.fromParent("inherit", undefined)).toBe("balanced")
  })

  test("returns the tier itself for non-inherit", () => {
    expect(Tiering.fromParent("quality", undefined)).toBe("quality")
    expect(Tiering.fromParent("budget", "quality")).toBe("budget")
    expect(Tiering.fromParent("balanced", "budget")).toBe("balanced")
  })
})
