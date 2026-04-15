import { appendFile, mkdir, readFile } from "fs/promises"
import { homedir } from "os"
import path from "path"

/**
 * Append-only JSONL log of memory injections and consolidations.
 *
 * One line per event, keyed by sessionID + timestamp. Consumed by:
 * - `/memory stats` command (aggregates counts and latency over recent window)
 * - Future TUI footer segment (polls the tail for current session)
 * - External analysis / dashboards
 *
 * Location: `~/.local/share/meridian/memory-injections.jsonl`. Kept in the
 * same dir as routing-decisions.jsonl from the model-router for convenience.
 *
 * Never throws. Write failures are silently dropped — this is telemetry,
 * not business logic.
 */

const LOG_DIR = path.join(homedir(), ".local", "share", "meridian")
const LOG_PATH = path.join(LOG_DIR, "memory-injections.jsonl")

export type InjectionLogEntry =
  | {
      kind: "inject"
      ts: number
      sessionID: string
      scope: string
      bytes: number
      fingerprint: string
      cached: boolean
      style: "full" | "index"
    }
  | {
      kind: "capture"
      ts: number
      sessionID: string
      scope: string
      title: string
      importance: number
      tags: string[]
    }
  | {
      kind: "consolidate"
      ts: number
      scope: string
      ops: { merge: number; rewrite: number; promote: number; delete: number }
      considered: number
      durationMs: number
    }
  | {
      kind: "command"
      ts: number
      sessionID: string
      verb: string
      ok: boolean
    }

export async function logEntry(entry: InjectionLogEntry): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf8")
  } catch {
    // silent — telemetry failures never block the hot path
  }
}

export function logPath(): string {
  return LOG_PATH
}

/**
 * Read the last `maxLines` entries from the log. Used by `/memory stats`.
 * Returns an empty array on any read error.
 */
export async function readRecent(maxLines = 500): Promise<InjectionLogEntry[]> {
  try {
    const raw = await readFile(LOG_PATH, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim())
    const tail = lines.slice(-maxLines)
    const out: InjectionLogEntry[] = []
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line) as InjectionLogEntry
        out.push(parsed)
      } catch {
        // skip malformed lines
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Aggregate recent log entries into a compact stats summary. Keyed by
 * (session, scope) and broken down by kind.
 */
export interface LogStats {
  totalInjections: number
  cacheHitRate: number
  avgBytes: number
  totalCaptures: number
  totalConsolidations: number
  opCounts: { merge: number; rewrite: number; promote: number; delete: number }
  byScope: Array<{ scope: string; injections: number; captures: number }>
}

export function aggregateStats(entries: InjectionLogEntry[]): LogStats {
  let injections = 0
  let cacheHits = 0
  let totalBytes = 0
  let captures = 0
  let consolidations = 0
  const opCounts = { merge: 0, rewrite: 0, promote: 0, delete: 0 }
  const scopeMap = new Map<string, { injections: number; captures: number }>()

  const touchScope = (scope: string) => {
    let s = scopeMap.get(scope)
    if (!s) {
      s = { injections: 0, captures: 0 }
      scopeMap.set(scope, s)
    }
    return s
  }

  for (const e of entries) {
    if (e.kind === "inject") {
      injections++
      if (e.cached) cacheHits++
      totalBytes += e.bytes
      touchScope(e.scope).injections++
    } else if (e.kind === "capture") {
      captures++
      touchScope(e.scope).captures++
    } else if (e.kind === "consolidate") {
      consolidations++
      opCounts.merge += e.ops.merge
      opCounts.rewrite += e.ops.rewrite
      opCounts.promote += e.ops.promote
      opCounts.delete += e.ops.delete
    }
  }

  return {
    totalInjections: injections,
    cacheHitRate: injections > 0 ? cacheHits / injections : 0,
    avgBytes: injections > 0 ? Math.round(totalBytes / injections) : 0,
    totalCaptures: captures,
    totalConsolidations: consolidations,
    opCounts,
    byScope: [...scopeMap.entries()].map(([scope, stats]) => ({ scope, ...stats })),
  }
}
