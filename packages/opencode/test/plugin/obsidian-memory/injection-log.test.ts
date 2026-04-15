import { describe, expect, test } from "bun:test"
import {
  aggregateStats,
  type InjectionLogEntry,
} from "../../../src/plugin/obsidian-memory/injection-log"

describe("aggregateStats", () => {
  test("empty input returns zeros", () => {
    const stats = aggregateStats([])
    expect(stats.totalInjections).toBe(0)
    expect(stats.cacheHitRate).toBe(0)
    expect(stats.avgBytes).toBe(0)
    expect(stats.totalCaptures).toBe(0)
    expect(stats.totalConsolidations).toBe(0)
  })

  test("computes injection stats", () => {
    const entries: InjectionLogEntry[] = [
      { kind: "inject", ts: 1, sessionID: "s1", scope: "repo-a::main", bytes: 1000, fingerprint: "aaa", cached: false, style: "full" },
      { kind: "inject", ts: 2, sessionID: "s1", scope: "repo-a::main", bytes: 1000, fingerprint: "aaa", cached: true, style: "full" },
      { kind: "inject", ts: 3, sessionID: "s1", scope: "repo-a::main", bytes: 1200, fingerprint: "bbb", cached: false, style: "full" },
    ]
    const stats = aggregateStats(entries)
    expect(stats.totalInjections).toBe(3)
    expect(stats.cacheHitRate).toBeCloseTo(1 / 3, 5)
    expect(stats.avgBytes).toBe(Math.round((1000 + 1000 + 1200) / 3))
  })

  test("groups by scope", () => {
    const entries: InjectionLogEntry[] = [
      { kind: "inject", ts: 1, sessionID: "s", scope: "a::main", bytes: 100, fingerprint: "x", cached: false, style: "full" },
      { kind: "inject", ts: 2, sessionID: "s", scope: "b::dev", bytes: 100, fingerprint: "x", cached: false, style: "full" },
      { kind: "inject", ts: 3, sessionID: "s", scope: "a::main", bytes: 100, fingerprint: "x", cached: false, style: "full" },
      { kind: "capture", ts: 4, sessionID: "s", scope: "a::main", title: "t", importance: 0.5, tags: [] },
    ]
    const stats = aggregateStats(entries)
    const byScope = new Map(stats.byScope.map((s) => [s.scope, s]))
    expect(byScope.get("a::main")?.injections).toBe(2)
    expect(byScope.get("a::main")?.captures).toBe(1)
    expect(byScope.get("b::dev")?.injections).toBe(1)
  })

  test("counts consolidation operations", () => {
    const entries: InjectionLogEntry[] = [
      {
        kind: "consolidate",
        ts: 1,
        scope: "a::main",
        ops: { merge: 2, rewrite: 3, promote: 1, delete: 5 },
        considered: 15,
        durationMs: 4500,
      },
      {
        kind: "consolidate",
        ts: 2,
        scope: "a::main",
        ops: { merge: 0, rewrite: 1, promote: 0, delete: 2 },
        considered: 8,
        durationMs: 2000,
      },
    ]
    const stats = aggregateStats(entries)
    expect(stats.totalConsolidations).toBe(2)
    expect(stats.opCounts.merge).toBe(2)
    expect(stats.opCounts.rewrite).toBe(4)
    expect(stats.opCounts.promote).toBe(1)
    expect(stats.opCounts.delete).toBe(7)
  })

  test("cache hit rate is 100% when all cached", () => {
    const entries: InjectionLogEntry[] = [
      { kind: "inject", ts: 1, sessionID: "s", scope: "a::main", bytes: 100, fingerprint: "x", cached: true, style: "full" },
      { kind: "inject", ts: 2, sessionID: "s", scope: "a::main", bytes: 100, fingerprint: "x", cached: true, style: "full" },
    ]
    const stats = aggregateStats(entries)
    expect(stats.cacheHitRate).toBe(1)
  })
})
