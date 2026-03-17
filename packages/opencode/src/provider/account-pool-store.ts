import { Database, eq } from "@/storage/db"
import { AccountUsageTable } from "./account-pool.sql"
import type { AccountPool } from "./account-pool"
import { Global } from "@/global"
import path from "path"
import fs from "fs"

export type PersistedState = {
  index: number
  requestCount: number
  tokenCount: number
  lastUsedAt: number
  cooldownUntil?: number
  status: AccountPool.Status
  switchCount: number
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function loadStats(providerID: string): PersistedState[] {
  return Database.use((db) => {
    const rows = db.select().from(AccountUsageTable).where(eq(AccountUsageTable.provider_id, providerID)).all()
    return rows.map((row) => ({
      index: row.account_index,
      requestCount: row.request_count,
      tokenCount: row.token_count,
      lastUsedAt: row.last_used_at ?? 0,
      cooldownUntil: row.cooldown_until ?? undefined,
      status: row.disabled ? ("disabled" as const) : ("active" as const),
      switchCount: row.switch_count,
    }))
  })
}

export function saveStats(providerID: string, states: AccountPool.State[]): void {
  Database.transaction((tx) => {
    for (const s of states) {
      const id = `${providerID}:${s.info.index}`
      tx.insert(AccountUsageTable)
        .values({
          id,
          provider_id: providerID,
          account_index: s.info.index,
          request_count: s.requestCount,
          token_count: s.tokenCount,
          last_used_at: s.lastUsedAt || null,
          cooldown_until: s.cooldownUntil ?? null,
          disabled: s.status === "disabled" ? 1 : 0,
          switch_count: s.switchCount,
        })
        .onConflictDoUpdate({
          target: AccountUsageTable.id,
          set: {
            request_count: s.requestCount,
            token_count: s.tokenCount,
            last_used_at: s.lastUsedAt || null,
            cooldown_until: s.cooldownUntil ?? null,
            disabled: s.status === "disabled" ? 1 : 0,
            switch_count: s.switchCount,
          },
        })
        .run()
    }
  })
}

export function clearStats(providerID: string): void {
  Database.use((db) => {
    db.delete(AccountUsageTable).where(eq(AccountUsageTable.provider_id, providerID)).run()
  })
}

export function debouncedSave(providerID: string, states: AccountPool.State[]): void {
  const existing = timers.get(providerID)
  if (existing) clearTimeout(existing)
  timers.set(
    providerID,
    setTimeout(() => {
      timers.delete(providerID)
      saveStats(providerID, states)
    }, 5000),
  )
}

export function immediateSave(providerID: string, states: AccountPool.State[]): void {
  const existing = timers.get(providerID)
  if (existing) {
    clearTimeout(existing)
    timers.delete(providerID)
  }
  saveStats(providerID, states)
}

export function reloadCooldowns(providerID: string, states: AccountPool.State[]): void {
  const persisted = loadStats(providerID)
  for (const p of persisted) {
    if (p.index >= states.length) continue
    const s = states[p.index]
    if (p.status === "disabled" && s.status !== "disabled") {
      s.status = "disabled"
    } else if (p.status !== "disabled" && s.status === "disabled") {
      s.status = "active"
      s.cooldownUntil = undefined
    }
    if (p.cooldownUntil && (!s.cooldownUntil || p.cooldownUntil > s.cooldownUntil)) {
      s.cooldownUntil = p.cooldownUntil
      if (s.status === "active") s.status = "cooldown"
    }
  }
}

const poolStatePath = path.join(Global.Path.data, "pool-active.json")

export function loadActiveIndex(providerID: string): number | undefined {
  try {
    const raw = fs.readFileSync(poolStatePath, "utf-8")
    const data = JSON.parse(raw)
    const idx = data[providerID]
    return typeof idx === "number" ? idx : undefined
  } catch {
    return undefined
  }
}

export function saveActiveIndex(providerID: string, index: number): void {
  let data: Record<string, number> = {}
  try {
    const raw = fs.readFileSync(poolStatePath, "utf-8")
    data = JSON.parse(raw)
  } catch {}
  data[providerID] = index
  fs.writeFileSync(poolStatePath, JSON.stringify(data), "utf-8")
}
