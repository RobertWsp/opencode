import { Database, eq } from "@/storage/db"
import { AccountUsageTable } from "./account-pool.sql"
import type { AccountPool } from "./account-pool"

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
