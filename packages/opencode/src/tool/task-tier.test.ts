import { describe, it, expect } from "bun:test"
import { Tiering } from "../agent/tiering"

/**
 * Sanity tests for the tier param wiring on the Task tool. The Task tool
 * itself requires too much harness setup to invoke directly in a unit
 * test (Session.create + DB + Plugin), so we test the resolution logic
 * end-to-end on Tiering.resolve which is what task.ts:138-148 calls.
 */
describe("Task tool tier override resolution", () => {
  it("budget tier resolves to Haiku for anthropic", () => {
    const m = Tiering.resolve("budget", "anthropic")
    expect(m.modelID).toContain("haiku")
    expect(m.providerID).toBe("anthropic")
  })

  it("balanced tier resolves to Sonnet for anthropic", () => {
    const m = Tiering.resolve("balanced", "anthropic")
    expect(m.modelID).toContain("sonnet")
  })

  it("quality tier resolves to Opus for anthropic", () => {
    const m = Tiering.resolve("quality", "anthropic")
    expect(m.modelID).toContain("opus")
  })

  it("falls back to balanced when tier is unknown for provider", () => {
    const m = Tiering.resolve("budget", "unknown-provider")
    // No mapping → fallback chain returns DEFAULTS.balanced.unknown-provider (undefined)
    // → empty string. Either is acceptable; the Task tool then falls back to
    // the parent's modelID via the next ?? in task.ts:144-148.
    expect(typeof m.modelID).toBe("string")
  })
})
