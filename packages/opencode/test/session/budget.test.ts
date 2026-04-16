import { describe, expect, test } from "bun:test"
import { Budget } from "../../src/session/budget"

describe("session.budget.track", () => {
  test("records usage", () => {
    Budget.track("budget-track-1", "build", { input: 100, output: 50 }, 200)
    const u = Budget.usage("budget-track-1", "build")
    expect(u.tokens.input).toBe(100)
    expect(u.tokens.output).toBe(50)
    expect(u.cost).toBe(200)
    expect(u.calls).toBe(1)
    Budget.reset("budget-track-1")
  })
})

describe("session.budget.usage", () => {
  test("returns tracked data", () => {
    Budget.track("budget-usage-1", "build", { input: 10, output: 20 }, 100)
    Budget.track("budget-usage-1", "build", { input: 5, output: 10 }, 50)
    const u = Budget.usage("budget-usage-1", "build")
    expect(u.tokens.input).toBe(15)
    expect(u.tokens.output).toBe(30)
    expect(u.cost).toBe(150)
    expect(u.calls).toBe(2)
    Budget.reset("budget-usage-1")
  })

  test("returns zeros for unknown session", () => {
    const u = Budget.usage("budget-unknown-xyz")
    expect(u.tokens.input).toBe(0)
    expect(u.tokens.output).toBe(0)
    expect(u.cost).toBe(0)
    expect(u.calls).toBe(0)
  })
})

describe("session.budget.check", () => {
  test("returns ok under limit", () => {
    Budget.track("budget-check-ok", "build", { input: 10, output: 10 }, 100)
    expect(Budget.check("budget-check-ok", { session: 1000, agent: 1000 })).toBe("ok")
    Budget.reset("budget-check-ok")
  })

  test("returns warn at 80%", () => {
    Budget.track("budget-check-warn", "build", { input: 10, output: 10 }, 900)
    expect(Budget.check("budget-check-warn", { session: 1000, agent: 1000 })).toBe("warn")
    Budget.reset("budget-check-warn")
  })

  test("returns exceeded over limit", () => {
    Budget.track("budget-check-exceeded", "build", { input: 10, output: 10 }, 1001)
    expect(Budget.check("budget-check-exceeded", { session: 1000, agent: 1000 })).toBe("exceeded")
    Budget.reset("budget-check-exceeded")
  })
})

describe("session.budget.reset", () => {
  test("clears session data", () => {
    Budget.track("budget-reset-1", "build", { input: 100, output: 100 }, 500)
    Budget.reset("budget-reset-1")
    const u = Budget.usage("budget-reset-1")
    expect(u.cost).toBe(0)
    expect(u.calls).toBe(0)
  })
})

describe("session.budget.format", () => {
  test("returns readable summary", () => {
    Budget.track("budget-format-1", "build", { input: 100, output: 50 }, 500)
    const out = Budget.format("budget-format-1")
    expect(out).toContain("session cost:")
    expect(out).toContain("build")
    Budget.reset("budget-format-1")
  })
})
