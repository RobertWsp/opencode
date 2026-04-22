import type { MemoryEntry } from "./types"

const DAY_MS = 86_400_000
const DEFAULT_RETENTION_DAYS = 90

export function isExpired(entry: MemoryEntry, now = Date.now()): boolean {
  if (!entry.validUntil) return false
  const ts = Date.parse(entry.validUntil)
  if (isNaN(ts)) return false
  return now > ts
}

export function isStale(entry: MemoryEntry, retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now()): boolean {
  if (!entry.created) return false
  const ts = Date.parse(entry.created)
  if (isNaN(ts)) return false
  if (entry.importance >= 0.9) return false
  const ageDays = (now - ts) / DAY_MS
  return ageDays > retentionDays
}

export function filterActive(entries: MemoryEntry[], retentionDays?: number, now?: number): MemoryEntry[] {
  return entries.filter((e) => !isExpired(e, now) && !isStale(e, retentionDays, now))
}

export function tokenEstimate(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function staleEntries(entries: MemoryEntry[], retentionDays?: number, now?: number): MemoryEntry[] {
  return entries.filter((e) => isExpired(e, now) || isStale(e, retentionDays, now))
}
