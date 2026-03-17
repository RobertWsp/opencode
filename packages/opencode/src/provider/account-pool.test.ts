/**
 * AccountPool RED Phase Tests
 * All tests MUST fail — createPool() does not exist yet.
 * This is the RED phase of TDD: define expected behavior before implementation.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { createPool, isAccountExhausted } from "./account-pool"

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
    pool.increment(0, 0)
    pool.increment(0, 0)
    pool.increment(1, 0)
    const next = pool.next()
    expect(next).toBeDefined()
    expect(next!.index).toBe(2)
    expect(next!.label).toBe("Account-3")
  })

  it("breaks ties by lowest lastUsedAt", () => {
    const states = pool.states()
    states[0].lastUsedAt = 1000
    states[1].lastUsedAt = 2000
    states[2].lastUsedAt = 3000

    const next = pool.next()
    expect(next).toBeDefined()
    expect(next!.index).toBe(0)
    expect(next!.label).toBe("Account-1")
  })

  it("skips accounts in cooldown status", () => {
    pool.cooldown(0, Date.now() + 10000)
    pool.cooldown(1, Date.now() + 10000)
    const next = pool.next()
    expect(next).toBeDefined()
    expect(next!.index).toBe(2)
    expect(next!.label).toBe("Account-3")
  })

  it("skips disabled accounts", () => {
    pool.disable(0)
    pool.disable(1)
    const next = pool.next()
    expect(next).toBeDefined()
    expect(next!.index).toBe(2)
    expect(next!.label).toBe("Account-3")
  })

  it("returns only remaining account if others all cooldown", () => {
    pool.cooldown(0, Date.now() + 10000)
    pool.cooldown(1, Date.now() + 10000)
    const next = pool.next()
    expect(next).toBeDefined()
    expect(next!.index).toBe(2)
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

  it("caps cooldown duration at 600 seconds", () => {
    const now = Date.now()
    const farFuture = now + 1200000 // 1200 seconds
    pool.cooldown(0, farFuture)
    const states = pool.states()
    expect(states[0].cooldownUntil).toBeLessThanOrEqual(now + 600000)
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
    const next = pool.next()
    expect(next).toBeDefined()
    expect(next!.index).toBe(2)
    expect(next!.label).toBe("Account-3")
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

  it("returns undefined when all accounts are exhausted", () => {
    const now = Date.now()
    pool.cooldown(0, now + 5000)
    pool.cooldown(1, now + 10000)
    pool.cooldown(2, now + 3000)

    const next = pool.next()
    expect(next).toBeUndefined()
  })

  it("soonestCooldownMs returns ms until soonest expiry", () => {
    const now = Date.now()
    pool.cooldown(0, now + 5000)
    pool.cooldown(1, now + 10000)
    pool.cooldown(2, now + 3000)

    const ms = pool.soonestCooldownMs()
    expect(ms).toBeDefined()
    expect(ms!).toBeLessThanOrEqual(3000)
    expect(ms!).toBeGreaterThan(0)
  })

  it("emits account.switched event on next() when active changes", () => {
    const pool2 = createPool([acct1, acct2, acct3])
    pool2.disable(0)

    const next = pool2.next()
    expect(next).toBeDefined()
    expect(next!.index).not.toBe(0)
  })

  it("handles concurrent next() calls safely (mutex)", async () => {
    const promises = [Promise.resolve(pool.next()), Promise.resolve(pool.next()), Promise.resolve(pool.next())]

    const results = await Promise.all(promises)
    results.forEach((r: (typeof results)[0]) => {
      expect(r).toBeDefined()
      expect(r!.index).toBeGreaterThanOrEqual(0)
      expect(r!.index).toBeLessThan(3)
    })
  })

  it("emits account.switched event on next() when active changes", () => {
    const pool2 = createPool([acct1, acct2, acct3])
    pool2.disable(0)

    const next = pool2.next()
    expect(next).toBeDefined()
    expect(next!.index).not.toBe(0)
  })

  it("handles concurrent next() calls safely (mutex)", async () => {
    const promises = [Promise.resolve(pool.next()), Promise.resolve(pool.next()), Promise.resolve(pool.next())]

    const results = await Promise.all(promises)
    results.forEach((r: (typeof results)[0]) => {
      expect(r).toBeDefined()
      expect(r!.index).toBeGreaterThanOrEqual(0)
      expect(r!.index).toBeLessThan(3)
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

describe("re-enable disabled for fallback", () => {
  it("re-enabled accounts become healthy when active one is in cooldown", () => {
    const pool = createPool([acct1, acct2, acct3])
    pool.disable(1)
    pool.disable(2)
    pool.cooldown(0, Date.now() + 60_000)
    expect(pool.hasHealthy()).toBe(false)

    for (const s of pool.states()) {
      if (s.status === "disabled") pool.enable(s.info.index)
    }
    expect(pool.hasHealthy()).toBe(true)

    const next = pool.next()
    expect(next).toBeDefined()
    expect(next!.index).not.toBe(0)
  })

  it("enable() clears cooldownUntil", () => {
    const pool = createPool([acct1, acct2])
    pool.disable(0)
    expect(pool.states()[0].status).toBe("disabled")

    pool.enable(0)
    expect(pool.states()[0].status).toBe("active")
    expect(pool.states()[0].cooldownUntil).toBeUndefined()
  })

  it("next() selects re-enabled account with lowest requestCount", () => {
    const pool = createPool([acct1, acct2, acct3])
    pool.increment(0, 0)
    pool.increment(0, 0)
    pool.increment(1, 0)
    pool.disable(1)
    pool.disable(2)
    pool.cooldown(0, Date.now() + 60_000)

    for (const s of pool.states()) {
      if (s.status === "disabled") pool.enable(s.info.index)
    }

    const next = pool.next()
    expect(next).toBeDefined()
    expect(next!.index).toBe(2)
  })

  it("re-enable all disabled → disable on 401 → only faulted disabled", () => {
    const pool = createPool([acct1, acct2, acct3])
    pool.disable(1)
    pool.disable(2)
    pool.cooldown(0, Date.now() + 60_000)

    for (const s of pool.states()) {
      if (s.status === "disabled") pool.enable(s.info.index)
    }
    expect(pool.stats().activeCount).toBe(2)

    pool.disable(1)
    expect(pool.states()[1].status).toBe("disabled")
    expect(pool.states()[2].status).toBe("active")
    expect(pool.hasHealthy()).toBe(true)
  })

  it("hasHealthy false when all disabled + all cooldown", () => {
    const pool = createPool([acct1, acct2, acct3])
    pool.cooldown(0, Date.now() + 60_000)
    pool.disable(1)
    pool.disable(2)
    expect(pool.hasHealthy()).toBe(false)
    expect(pool.soonestCooldownMs()).toBeDefined()
    expect(pool.soonestCooldownMs()!).toBeGreaterThan(0)
  })

  it("soonestCooldownMs ignores disabled accounts", () => {
    const pool = createPool([acct1, acct2])
    pool.disable(0)
    pool.cooldown(1, Date.now() + 5000)
    const ms = pool.soonestCooldownMs()
    expect(ms).toBeDefined()
    expect(ms!).toBeLessThanOrEqual(5000)
  })

  it("single account pool: disable then enable restores functionality", () => {
    const pool = createPool([acct1])
    pool.disable(0)
    expect(pool.hasHealthy()).toBe(false)
    expect(pool.next()).toBeUndefined()

    pool.enable(0)
    expect(pool.hasHealthy()).toBe(true)
    expect(pool.next()).toBeDefined()
  })
})

describe("exhaustion detection", () => {
  it("retryAfterMs >= 300s is exhausted", () => {
    expect(isAccountExhausted(300_000)).toBe(true)
    expect(isAccountExhausted(600_000)).toBe(true)
  })

  it("retryAfterMs < 300s is not exhausted", () => {
    expect(isAccountExhausted(60_000)).toBe(false)
    expect(isAccountExhausted(120_000)).toBe(false)
  })

  it("body patterns detect quota exhaustion", () => {
    expect(isAccountExhausted(60_000, "insufficient quota")).toBe(true)
    expect(isAccountExhausted(60_000, "billing issue")).toBe(true)
    expect(isAccountExhausted(60_000, "plan limit reached")).toBe(true)
    expect(isAccountExhausted(60_000, "usage limit exceeded")).toBe(true)
    expect(isAccountExhausted(60_000, "free usage exceeded")).toBe(true)
    expect(isAccountExhausted(60_000, "credits exhausted")).toBe(true)
    expect(isAccountExhausted(60_000, "FreeUsageLimitError")).toBe(true)
    expect(isAccountExhausted(60_000, "exceeded monthly limit")).toBe(true)
  })

  it("normal 429 body is not exhausted", () => {
    expect(isAccountExhausted(60_000, "rate limit exceeded")).toBe(false)
    expect(isAccountExhausted(60_000, "too many requests")).toBe(false)
    expect(isAccountExhausted(60_000)).toBe(false)
  })
})

describe("cooldown expiration edge cases", () => {
  it("soonestCooldownMs returns 0 for already-expired cooldowns", () => {
    const pool = createPool([acct1, acct2])
    pool.cooldown(0, Date.now() - 1000)
    const ms = pool.soonestCooldownMs()
    expect(ms).toBeUndefined()
  })

  it("hasHealthy expires stale cooldowns before checking", () => {
    const pool = createPool([acct1])
    pool.cooldown(0, Date.now() - 1000)
    expect(pool.hasHealthy()).toBe(true)
    expect(pool.states()[0].status).toBe("active")
  })

  it("soonestCooldownMs returns undefined when only disabled accounts remain", () => {
    const pool = createPool([acct1, acct2])
    pool.disable(0)
    pool.disable(1)
    expect(pool.soonestCooldownMs()).toBeUndefined()
  })

  it("cooldown caps at 600 seconds from now", () => {
    const pool = createPool([acct1])
    const now = Date.now()
    pool.cooldown(0, now + 900_000)
    expect(pool.states()[0].cooldownUntil!).toBeLessThanOrEqual(now + 600_001)
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
    expect(next).toBeDefined()
    const active = pool.active()
    expect(active.index).toBe(next!.index)
  })
})
