import { describe, it, expect } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { sql } from "drizzle-orm"
import { ResourceUsageTable } from "./usage.sql"

const TABLE_SQL = `CREATE TABLE resource_usage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  date TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
)`

function setup() {
  const sqlite = new BunDatabase(":memory:")
  sqlite.run(TABLE_SQL)
  return drizzle({ client: sqlite })
}

function upsert(db: ReturnType<typeof setup>, pid: string, type: string, name: string, ms: number) {
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
}

describe("usage", () => {
  it("inserts new record", () => {
    const db = setup()
    upsert(db, "proj-1", "tool", "read", 150)
    const rows = db.select().from(ResourceUsageTable).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].call_count).toBe(1)
    expect(rows[0].total_latency_ms).toBe(150)
    expect(rows[0].resource_type).toBe("tool")
    expect(rows[0].resource_name).toBe("read")
    expect(rows[0].project_id).toBe("proj-1")
  })

  it("aggregates on conflict with same id", () => {
    const db = setup()
    upsert(db, "proj-1", "tool", "read", 100)
    upsert(db, "proj-1", "tool", "read", 200)
    const rows = db.select().from(ResourceUsageTable).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].call_count).toBe(2)
    expect(rows[0].total_latency_ms).toBe(300)
  })

  it("keeps separate rows for different tools", () => {
    const db = setup()
    upsert(db, "proj-1", "tool", "read", 100)
    upsert(db, "proj-1", "tool", "write", 200)
    const rows = db.select().from(ResourceUsageTable).all()
    expect(rows).toHaveLength(2)
  })

  it("keeps separate rows for different projects", () => {
    const db = setup()
    upsert(db, "proj-1", "tool", "read", 100)
    upsert(db, "proj-2", "tool", "read", 200)
    const rows = db.select().from(ResourceUsageTable).all()
    expect(rows).toHaveLength(2)
  })

  it("uses date as part of composite key", () => {
    const db = setup()
    const now = Date.now()
    db.insert(ResourceUsageTable)
      .values({
        id: "proj-1:read:2026-03-05",
        project_id: "proj-1",
        resource_type: "tool",
        resource_name: "read",
        call_count: 1,
        total_latency_ms: 100,
        last_used_at: now,
        date: "2026-03-05",
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(ResourceUsageTable)
      .values({
        id: "proj-1:read:2026-03-06",
        project_id: "proj-1",
        resource_type: "tool",
        resource_name: "read",
        call_count: 1,
        total_latency_ms: 200,
        last_used_at: now,
        date: "2026-03-06",
        time_created: now,
        time_updated: now,
      })
      .run()
    const rows = db.select().from(ResourceUsageTable).all()
    expect(rows).toHaveLength(2)
  })

  it("updates last_used_at on conflict", () => {
    const db = setup()
    upsert(db, "proj-1", "tool", "read", 50)
    const before = db.select().from(ResourceUsageTable).all()[0].last_used_at!
    upsert(db, "proj-1", "tool", "read", 75)
    const after = db.select().from(ResourceUsageTable).all()[0].last_used_at!
    expect(after).toBeGreaterThanOrEqual(before)
  })

  it("generates deterministic id from pid:name:date", () => {
    const db = setup()
    upsert(db, "proj-1", "mcp", "my-tool", 100)
    const rows = db.select().from(ResourceUsageTable).all()
    const today = new Date().toISOString().slice(0, 10)
    expect(rows[0].id).toBe(`proj-1:my-tool:${today}`)
  })

  it("handles zero latency", () => {
    const db = setup()
    upsert(db, "proj-1", "tool", "fast", 0)
    const rows = db.select().from(ResourceUsageTable).all()
    expect(rows[0].total_latency_ms).toBe(0)
  })

  it("handles high call volume", () => {
    const db = setup()
    for (let i = 0; i < 100; i++) {
      upsert(db, "proj-1", "tool", "read", 10)
    }
    const rows = db.select().from(ResourceUsageTable).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].call_count).toBe(100)
    expect(rows[0].total_latency_ms).toBe(1000)
  })
})
