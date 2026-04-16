import { Database, sql, lt } from "@/storage/db"
import { ResourceUsageTable } from "./usage.sql"

export function record(pid: string, type: string, name: string, ms: number): void {
  Database.effect(() => {
    const db = Database.Client()
    const date = new Date().toISOString().slice(0, 10)
    const now = Date.now()
    const id = `${pid}:${name}:${date}`
    db.insert(ResourceUsageTable)
      .values({
        id,
        project_id: pid,
        resource_type: type,
        resource_name: name,
        call_count: 1,
        total_latency_ms: ms,
        last_used_at: now,
        date,
        time_created: now,
        time_updated: now,
      })
      .onConflictDoUpdate({
        target: ResourceUsageTable.id,
        set: {
          call_count: sql`${ResourceUsageTable.call_count} + 1`,
          total_latency_ms: sql`${ResourceUsageTable.total_latency_ms} + ${ms}`,
          last_used_at: now,
          time_updated: now,
        },
      })
      .run()
    if (Math.random() < 0.01) {
      const cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      db.delete(ResourceUsageTable).where(lt(ResourceUsageTable.date, cutoff)).run()
    }
  })
}
