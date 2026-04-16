import { describe, expect, test } from "bun:test"
import { CircuitBreaker } from "../../src/session/circuit-breaker"

describe("session.circuit-breaker.create", () => {
  test("returns initial state with zeros", () => {
    const state = CircuitBreaker.create()
    expect(state.calls).toBe(0)
    expect(state.edits).toBe(0)
  })
})

describe("session.circuit-breaker.tick", () => {
  test("call increments calls", () => {
    const state = CircuitBreaker.tick(CircuitBreaker.create(), "call")
    expect(state.calls).toBe(1)
    expect(state.edits).toBe(0)
  })

  test("edit increments edits and updates lastProgress", () => {
    const before = Date.now()
    const state = CircuitBreaker.tick(CircuitBreaker.create(), "edit")
    expect(state.edits).toBe(1)
    expect(state.calls).toBe(0)
    expect(state.lastProgress).toBeGreaterThanOrEqual(before)
  })

  test("test updates lastProgress", () => {
    const before = Date.now()
    const state = CircuitBreaker.tick(CircuitBreaker.create(), "test")
    expect(state.calls).toBe(0)
    expect(state.edits).toBe(0)
    expect(state.lastProgress).toBeGreaterThanOrEqual(before)
  })
})

describe("session.circuit-breaker.check", () => {
  test("returns ok for fresh state", () => {
    expect(CircuitBreaker.check(CircuitBreaker.create())).toBe("ok")
  })

  test("trips when maxCalls exceeded without edits", () => {
    let state = CircuitBreaker.create()
    for (let i = 0; i <= CircuitBreaker.DEFAULTS.maxCalls; i++) {
      state = CircuitBreaker.tick(state, "call")
    }
    expect(CircuitBreaker.check(state)).toBe("trip")
  })

  test("does not trip if edits were made", () => {
    let state = CircuitBreaker.create()
    for (let i = 0; i <= CircuitBreaker.DEFAULTS.maxCalls; i++) {
      state = CircuitBreaker.tick(state, "call")
    }
    state = CircuitBreaker.tick(state, "edit")
    expect(CircuitBreaker.check(state)).toBe("ok")
  })
})
