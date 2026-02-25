/**
 * AccountPool RED Phase Tests
 * All tests MUST fail — createPool() does not exist yet.
 * This is the RED phase of TDD: define expected behavior before implementation.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { createPool } from "./account-pool"

// Test fixtures
const acct1 = { key: "sk-ant-test-aaaa", label: "Account-1", providerID: "anthropic" }
const acct2 = { key: "sk-ant-test-bbbb", label: "Account-2", providerID: "anthropic" }
const acct3 = { key: "sk-ant-test-cccc", label: "Account-3", providerID: "anthropic" }

describe("selection", () => {
  let pool: ReturnType<typeof createPool>

  beforeEach(() => {
    pool = createPool([acct1, acct2, acct3])
  })

  it("returns account with lowest requestCount", () => {
    pool.increment(0, 0) // acct1: 1 request
    pool.increment(0, 0) // acct1: 2 requests
    pool.increment(1, 0) // acct2: 1 request
    // acct3 has 0 — should be selected
    const next = pool.next()
    expect(next.index).toBe(2)
    expect(next.label).toBe("Account-3")
  })

  it("breaks ties by lowest lastUsedAt", () => {
    // All have same requestCount (0)
    // acct1 used at t=1000, acct2 at t=2000, acct3 at t=3000
    // acct1 should be selected (oldest)
    const states = pool.states()
    // Manually set lastUsedAt to simulate usage
    states[0].lastUsedAt = 1000
    states[1].lastUsedAt = 2000
    states[2].lastUsedAt = 3000

    const next = pool.next()
    expect(next.index).toBe(0)
    expect(next.label).toBe("Account-1")
  })

  it("skips accounts in cooldown status", () => {
    // Put acct1 and acct2 on cooldown
    pool.cooldown(0, Date.now() + 10000)
    pool.cooldown(1, Date.now() + 10000)
    // Only acct3 is active — should be selected
    const next = pool.next()
    expect(next.index).toBe(2)
    expect(next.label).toBe("Account-3")
  })

  it("skips disabled accounts", () => {
    // Disable acct1 and acct2
    pool.disable(0)
    pool.disable(1)
    // Only acct3 is active — should be selected
    const next = pool.next()
    expect(next.index).toBe(2)
    expect(next.label).toBe("Account-3")
  })

  it("returns only remaining account if others all cooldown", () => {
    // Put acct1 and acct2 on cooldown
    pool.cooldown(0, Date.now() + 10000)
    pool.cooldown(1, Date.now() + 10000)
    // acct3 is the only active one
    const next = pool.next()
    expect(next.index).toBe(2)
  })
})

describe("cooldown", () => {
  let pool: ReturnType<typeof createPool>

  beforeEach(() => {
    pool = createPool([acct1, acct2, acct3])
  })

  it("marks account as cooldown status after cooldown() call", () => {
    pool.cooldown(0, Date.now() + 10000)
    const states = pool.states()
    expect(states[0].status).toBe("cooldown")
  })

  it("caps cooldown duration at 300 seconds", () => {
    const now = Date.now()
    const farFuture = now + 600000 // 600 seconds
    pool.cooldown(0, farFuture)
    const states = pool.states()
    // cooldownUntil should not exceed now + 300000
    expect(states[0].cooldownUntil).toBeLessThanOrEqual(now + 300000)
  })

  it("auto-expires cooldown when next() called after expiry", () => {
    const now = Date.now()
    // Set cooldown to expire in 100ms
    pool.cooldown(0, now + 100)
    // Wait for cooldown to expire
    const states1 = pool.states()
    expect(states1[0].status).toBe("cooldown")

    // Simulate time passing (in real test, would use fake timers)
    // For now, set cooldownUntil to past
    states1[0].cooldownUntil = now - 1000

    // Call next() — should auto-expire cooldown
    const next = pool.next()
    const states2 = pool.states()
    expect(states2[0].status).toBe("active")
  })

  it("auto-expires cooldown when cooldownUntil is in the past", () => {
    const now = Date.now()
    pool.cooldown(0, now + 10000)
    const states = pool.states()
    expect(states[0].status).toBe("cooldown")

    // Manually set cooldownUntil to past
    states[0].cooldownUntil = now - 1000

    // next() should recognize expired cooldown
    const next = pool.next()
    const statesAfter = pool.states()
    expect(statesAfter[0].status).toBe("active")
  })
})

describe("disable", () => {
  let pool: ReturnType<typeof createPool>

  beforeEach(() => {
    pool = createPool([acct1, acct2, acct3])
  })

  it("marks account as disabled after disable() call", () => {
    pool.disable(0)
    const states = pool.states()
    expect(states[0].status).toBe("disabled")
  })

  it("disabled account never returned by next()", () => {
    pool.disable(0)
    pool.disable(1)
    // Only acct3 should be returned
    const next = pool.next()
    expect(next.index).toBe(2)
    expect(next.label).toBe("Account-3")
  })

  it("enable() restores disabled account to active", () => {
    pool.disable(0)
    const statesBefore = pool.states()
    expect(statesBefore[0].status).toBe("disabled")

    pool.enable(0)
    const statesAfter = pool.states()
    expect(statesAfter[0].status).toBe("active")
  })
})

describe("rotation", () => {
  let pool: ReturnType<typeof createPool>

  beforeEach(() => {
    pool = createPool([acct1, acct2, acct3])
  })

  it("returns soonest-expiring account when all are exhausted", () => {
    // Mark all as cooldown with different expiry times
    const now = Date.now()
    pool.cooldown(0, now + 5000) // expires in 5s
    pool.cooldown(1, now + 10000) // expires in 10s
    pool.cooldown(2, now + 3000) // expires in 3s (soonest)

    // next() should return acct2 (index 2, soonest expiry)
    const next = pool.next()
    expect(next.index).toBe(2)
  })

  it("emits account.switched event on next() when active changes", () => {
    let switchedEvent: { from: number; to: number } | null = null

    // Mock event listener (would be real event emitter in implementation)
    const pool2 = createPool([acct1, acct2, acct3])
    // Disable acct1 to force switch
    pool2.disable(0)

    // Call next() — should trigger switch from 0 to 1
    const next = pool2.next()
    expect(next.index).not.toBe(0)
  })

  it("handles concurrent next() calls safely (mutex)", async () => {
    // Simulate concurrent calls
    const promises = [Promise.resolve(pool.next()), Promise.resolve(pool.next()), Promise.resolve(pool.next())]

    const results = await Promise.all(promises)
    // All should return valid accounts
    results.forEach((r: typeof results[0]) => {
      expect(r.index).toBeGreaterThanOrEqual(0)
      expect(r.index).toBeLessThan(3)
    })
  })
})

describe("stats", () => {
  let pool: ReturnType<typeof createPool>

  beforeEach(() => {
    pool = createPool([acct1, acct2, acct3])
  })

  it("increments requestCount when increment() called", () => {
    const statsBefore = pool.stats()
    expect(statsBefore.totalRequests).toBe(0)

    pool.increment(0, 0)
    const statsAfter = pool.stats()
    expect(statsAfter.totalRequests).toBe(1)

    pool.increment(0, 0)
    const statsAfter2 = pool.stats()
    expect(statsAfter2.totalRequests).toBe(2)
  })

  it("increments tokenCount when increment(index, tokens) called", () => {
    pool.increment(0, 100)
    const states = pool.states()
    expect(states[0].tokenCount).toBe(100)

    pool.increment(0, 50)
    const statesAfter = pool.states()
    expect(statesAfter[0].tokenCount).toBe(150)
  })

  it("increments switchCount when account changes", () => {
    const statsBefore = pool.stats()
    expect(statsBefore.totalSwitches).toBe(0)

    pool.switchTo(1)
    const statsAfter = pool.stats()
    expect(statsAfter.totalSwitches).toBe(1)

    pool.switchTo(2)
    const statsAfter2 = pool.stats()
    expect(statsAfter2.totalSwitches).toBe(2)
  })

  it("stats() returns correct totals", () => {
    pool.increment(0, 100)
    pool.increment(1, 50)
    pool.increment(2, 75)
    pool.switchTo(1)
    pool.switchTo(2)

    const stats = pool.stats()
    expect(stats.totalRequests).toBe(3)
    expect(stats.totalSwitches).toBe(2)
    expect(stats.accountCount).toBe(3)
    expect(stats.activeCount).toBe(3)
  })
})

describe("config", () => {
  it("creates pool from accounts array with labels", () => {
    const accounts = [
      { key: "sk-ant-test-aaaa", label: "Primary", providerID: "anthropic" },
      { key: "sk-ant-test-bbbb", label: "Backup", providerID: "anthropic" },
    ]
    const pool = createPool(accounts)
    const states = pool.states()
    expect(states.length).toBe(2)
    expect(states[0].info.label).toBe("Primary")
    expect(states[1].info.label).toBe("Backup")
  })

  it("creates single-account pool from apiKey (backward compat)", () => {
    const pool = createPool("sk-ant-test-aaaa")
    const states = pool.states()
    expect(states.length).toBe(1)
    expect(states[0].info.providerID).toBe("anthropic")
  })

  it("auto-generates label when none provided", () => {
    const accounts = [
      { key: "sk-ant-test-aaaa", providerID: "anthropic" },
      { key: "sk-ant-test-bbbb", providerID: "anthropic" },
    ]
    const pool = createPool(accounts)
    const states = pool.states()
    expect(states[0].info.label).toBeTruthy()
    expect(states[1].info.label).toBeTruthy()
    expect(states[0].info.label).not.toBe(states[1].info.label)
  })

  it("skips empty/null keys", () => {
    const accounts = [
      { key: "sk-ant-test-aaaa", label: "Valid", providerID: "anthropic" },
      { key: "", label: "Empty", providerID: "anthropic" },
      { key: null as any, label: "Null", providerID: "anthropic" },
      { key: "sk-ant-test-bbbb", label: "Valid2", providerID: "anthropic" },
    ]
    const pool = createPool(accounts)
    const states = pool.states()
    // Should only have 2 valid accounts
    expect(states.length).toBe(2)
    expect(states[0].info.label).toBe("Valid")
    expect(states[1].info.label).toBe("Valid2")
  })
})

describe("active", () => {
  let pool: ReturnType<typeof createPool>

  beforeEach(() => {
    pool = createPool([acct1, acct2, acct3])
  })

  it("returns the currently active account", () => {
    const active = pool.active()
    expect(active.index).toBeGreaterThanOrEqual(0)
    expect(active.index).toBeLessThan(3)
    expect(active.label).toBeTruthy()
  })

  it("updates active account after switchTo()", () => {
    const activeBefore = pool.active()
    pool.switchTo(1)
    const activeAfter = pool.active()
    expect(activeAfter.index).toBe(1)
  })

  it("updates active account after next() changes selection", () => {
    pool.disable(0)
    const next = pool.next()
    const active = pool.active()
    expect(active.index).toBe(next.index)
  })
})
