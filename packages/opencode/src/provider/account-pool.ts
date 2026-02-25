/**
 * AccountPool — type definitions and createPool() implementation.
 * Provides type-safe interfaces and runtime logic for multi-account management.
 */

import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"

export namespace AccountPool {
  /**
   * Identifies an account within a pool.
   * Stores metadata about the account without exposing the raw API key.
   */
  export type Info = {
    /** Zero-based index of the account in the pool */
    index: number
    /** Human-readable label for the account (e.g., "Account 1", "Backup Key") */
    label: string
    /** Provider identifier (e.g., "anthropic", "openai") */
    providerID: string
    /** xxHash32 of the raw API key — used for deduplication without storing the key */
    keyHash: number
  }

  /**
   * Runtime status of an account.
   * Determines whether the account can be used for requests.
   */
  export type Status = "active" | "cooldown" | "disabled"

  /**
   * Current runtime state of an account.
   * Tracks usage metrics and status transitions.
   */
  export type State = {
    /** Account metadata */
    info: Info
    /** Current status (active, cooldown, or disabled) */
    status: Status
    /** Total number of requests made with this account */
    requestCount: number
    /** Total number of tokens consumed by this account */
    tokenCount: number
    /** Unix timestamp (ms) of the last request using this account */
    lastUsedAt: number
    /** Unix timestamp (ms) until which the account is on cooldown (e.g., after 429 response) */
    cooldownUntil?: number
    /** Number of times this account has been manually switched to */
    switchCount: number
  }

  /**
   * Aggregate statistics for the entire pool.
   * Provides high-level metrics about pool health and usage.
   */
  export type Stats = {
    /** Total requests across all accounts in the pool */
    totalRequests: number
    /** Total manual switches across all accounts */
    totalSwitches: number
    /** Index of the currently active account */
    activeIndex: number
    /** Total number of accounts in the pool */
    accountCount: number
    /** Number of accounts currently in "active" status */
    activeCount: number
  }

  /**
   * The pool interface — defines the contract for account pool implementations.
   * Implemented in Wave 2 with concrete logic for load balancing and failover.
   */
  export type Pool = {
    /**
     * Get the currently active account.
     * @returns The Info of the account currently in use
     */
    active(): Info

    /**
     * Get the raw API key for the currently active account.
     * @returns The raw API key string
     */
    key(): string


    /**
     * Get the next account to use.
     * Selects the least-used account, skipping those in cooldown or disabled.
     * @returns The Info of the next account to use
     */
    next(): Info

    /**
     * Mark an account as on cooldown (e.g., after receiving a 429 response).
     * The account will be skipped by next() until the cooldown expires.
     * @param index - Zero-based index of the account
     * @param until - Unix timestamp (ms) until which the account should be on cooldown
     */
    cooldown(index: number, until: number): void

    /**
     * Permanently disable an account (e.g., after receiving a 401 response).
     * The account will not be used until re-enabled.
     * @param index - Zero-based index of the account
     */
    disable(index: number): void

    /**
     * Re-enable a previously disabled account.
     * @param index - Zero-based index of the account
     */
    enable(index: number): void

    /**
     * Manually switch to a specific account.
     * Increments the switchCount for that account.
     * @param index - Zero-based index of the account
     */
    switchTo(index: number): void

    /**
     * Increment request and token counters for an account.
     * Called after a successful request to track usage.
     * @param index - Zero-based index of the account
     * @param tokens - Optional number of tokens consumed (defaults to 0)
     */
    increment(index: number, tokens?: number): void

    /**
     * Get the current state of all accounts in the pool.
     * @returns Array of State objects, one per account
     */
    states(): State[]

    /**
     * Get pool-level statistics.
     * @returns Stats object with aggregate metrics
     */
    stats(): Stats

    /**
     * Check if at least one account is healthy (active, not in cooldown or disabled).
     * Expires stale cooldowns before checking.
     * @returns true if at least one account can accept requests
     */
    hasHealthy(): boolean

    /**
     * Get the auth.json key for the currently active account.
     * Used by pool-aware getAuth to resolve the correct credential.
     * @returns The auth key string (e.g., "anthropic", "anthropic:1")
     */
    authKey(): string
  }

  /**
   * Bus events for account pool state changes.
   * Emitted when accounts are switched, put on cooldown, or status changes.
   */
  export const Event = {
    /**
     * Emitted whenever the active account changes.
     * Includes the reason for the switch (429 rate limit, proactive rotation, or manual).
     */
    Switched: BusEvent.define(
      "account.switched",
      z.object({
        providerID: z.string(),
        fromIndex: z.number(),
        toIndex: z.number(),
        fromLabel: z.string(),
        toLabel: z.string(),
        reason: z.enum(["429", "proactive", "manual"]),
      }),
    ),

    /**
     * Emitted when an account is put on cooldown.
     * Typically triggered by a 429 (rate limit) response.
     */
    Cooldown: BusEvent.define(
      "account.cooldown",
      z.object({
        providerID: z.string(),
        accountIndex: z.number(),
        cooldownUntil: z.number(),
        reason: z.string(),
      }),
    ),

    /**
     * Emitted on status changes for TUI updates.
     * Provides a snapshot of all accounts and their current state.
     */
    Status: BusEvent.define(
      "account.status",
      z.object({
        providerID: z.string(),
        accounts: z.array(
          z.object({
            index: z.number(),
            label: z.string(),
            status: z.enum(["active", "cooldown", "disabled"]),
            requestCount: z.number(),
            tokenCount: z.number(),
            switchCount: z.number(),
            cooldownUntil: z.number().optional(),
          }),
        ),
      }),
    ),
  }
}

// ─── Implementation ───────────────────────────────────────────────────────────

type AccountInput = { key: string; label?: string; providerID: string; authKey?: string }

function tryPublish<D extends BusEvent.Definition>(def: D, props: Parameters<typeof Bus.publish<D>>[1]) {
  Bus.publish(def, props).catch(() => {})
}

function emitStatus(pool_states: AccountPool.State[]) {
  if (!pool_states.length) return
  const providerID = pool_states[0].info.providerID
  tryPublish(AccountPool.Event.Status, {
    providerID,
    accounts: pool_states.map((s) => ({
      index: s.info.index,
      label: s.info.label,
      status: s.status,
      requestCount: s.requestCount,
      tokenCount: s.tokenCount,
      switchCount: s.switchCount,
      cooldownUntil: s.cooldownUntil,
    })),
  })
}

function expireCooldowns(pool_states: AccountPool.State[]) {
  const now = Date.now()
  for (const s of pool_states) {
    if (s.status === "cooldown" && s.cooldownUntil !== undefined && s.cooldownUntil < now) {
      s.status = "active"
      s.cooldownUntil = undefined
    }
  }
}

function selectLeastUsed(pool_states: AccountPool.State[]): number {
  expireCooldowns(pool_states)
  const active = pool_states.filter((s) => s.status === "active")
  if (active.length) {
    const best = active.reduce((a, b) => {
      if (a.requestCount !== b.requestCount) return a.requestCount < b.requestCount ? a : b
      return a.lastUsedAt <= b.lastUsedAt ? a : b
    })
    return best.info.index
  }
  // All exhausted — return soonest cooldown
  const cooldowns = pool_states.filter((s) => s.status === "cooldown" && s.cooldownUntil !== undefined)
  if (cooldowns.length) {
    const soonest = cooldowns.reduce((a, b) => (a.cooldownUntil! < b.cooldownUntil! ? a : b))
    return soonest.info.index
  }
  return 0
}

export function createPool(accounts: AccountInput[] | string): AccountPool.Pool {
  const inputs: AccountInput[] =
    typeof accounts === "string"
      ? [{ key: accounts, label: "Account #1", providerID: "anthropic" }]
      : accounts

  const valid = inputs.filter((a) => a.key != null && a.key !== "")

  const pool_states: AccountPool.State[] = valid.map((a, i) => ({
    info: {
      index: i,
      label: a.label ?? `Account #${i + 1}`,
      providerID: a.providerID,
      keyHash: Bun.hash.xxHash32(a.key),
    },
    status: "active",
    requestCount: 0,
    tokenCount: 0,
    lastUsedAt: 0,
    cooldownUntil: undefined,
    switchCount: 0,
  }))

  let activeIndex = 0
  let rotating = false

  return {
    active() {
      return pool_states[activeIndex].info
    },

    key() {
      return valid[activeIndex].key
    },

    authKey() {
      return valid[activeIndex]?.authKey ?? valid[activeIndex]?.providerID ?? ""
    },

    next() {
      if (rotating) return pool_states[activeIndex].info
      rotating = true
      try {
        const selected = selectLeastUsed(pool_states)
        if (selected !== activeIndex) {
          const from = pool_states[activeIndex]
          const to = pool_states[selected]
          tryPublish(AccountPool.Event.Switched, {
            providerID: to.info.providerID,
            fromIndex: activeIndex,
            toIndex: selected,
            fromLabel: from.info.label,
            toLabel: to.info.label,
            reason: "proactive",
          })
          activeIndex = selected
        }
        return pool_states[activeIndex].info
      } finally {
        rotating = false
      }
    },

    cooldown(index, until) {
      const s = pool_states[index]
      const capped = Math.min(until, Date.now() + 300_000)
      s.cooldownUntil = capped
      s.status = "cooldown"
      tryPublish(AccountPool.Event.Cooldown, {
        providerID: s.info.providerID,
        accountIndex: index,
        cooldownUntil: capped,
        reason: "429",
      })
      emitStatus(pool_states)
    },

    disable(index) {
      pool_states[index].status = "disabled"
      emitStatus(pool_states)
    },

    enable(index) {
      pool_states[index].status = "active"
      pool_states[index].cooldownUntil = undefined
      emitStatus(pool_states)
    },

    switchTo(index) {
      const from = pool_states[activeIndex]
      const to = pool_states[index]
      to.switchCount++
      tryPublish(AccountPool.Event.Switched, {
        providerID: to.info.providerID,
        fromIndex: activeIndex,
        toIndex: index,
        fromLabel: from.info.label,
        toLabel: to.info.label,
        reason: "manual",
      })
      activeIndex = index
      emitStatus(pool_states)
    },

    increment(index, tokens) {
      const s = pool_states[index]
      s.requestCount++
      s.tokenCount += tokens ?? 0
      s.lastUsedAt = Date.now()
    },

    states() {
      return pool_states
    },

    stats() {
      return {
        totalRequests: pool_states.reduce((sum, s) => sum + s.requestCount, 0),
        totalSwitches: pool_states.reduce((sum, s) => sum + s.switchCount, 0),
        activeIndex,
        accountCount: pool_states.length,
        activeCount: pool_states.filter((s) => s.status === "active").length,
      }
    },

    hasHealthy() {
      expireCooldowns(pool_states)
      return pool_states.some((s) => s.status === "active")
    },
  }
}
