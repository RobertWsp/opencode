import type { CaptureEventInput } from "./capture-gate"

export interface SessionSummary {
  sessionID: string
  filesModified: string[]
  filesRead: string[]
  eventCount: number
  duration: number
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "bash", "mcp__oc__bash", "mcp__oc__edit", "mcp__oc__write"])

export function buildSummary(id: string, events: CaptureEventInput[], files: Set<string>): SessionSummary | null {
  if (events.length < 3) return null

  const modified: string[] = []
  const read: string[] = []
  const seen = new Set<string>()

  for (const ev of events) {
    const tool = (ev.details?.["tool"] as string | undefined) ?? ""
    const evFiles = (ev.details?.["files"] as string[] | undefined) ?? []
    const isWrite = WRITE_TOOLS.has(tool)
    for (const f of evFiles) {
      if (seen.has(f)) continue
      seen.add(f)
      if (isWrite) modified.push(f)
      else read.push(f)
    }
  }

  for (const f of files) {
    if (seen.has(f)) continue
    seen.add(f)
    read.push(f)
  }

  return {
    sessionID: id,
    filesModified: modified,
    filesRead: read,
    eventCount: events.length,
    duration: events[events.length - 1].timestamp - events[0].timestamp,
  }
}

export function formatSummaryNote(s: SessionSummary): { title: string; meta: Record<string, string>; body: string } {
  const title = `Session ${s.sessionID.slice(0, 8)} — ${s.eventCount} events`
  const meta: Record<string, string> = {
    "memory-kind": "session-summary",
    "session-id": s.sessionID,
    "event-count": String(s.eventCount),
    "duration-ms": String(s.duration),
  }

  const lines = [`## Session Summary`, ``, `**Events**: ${s.eventCount}`, `**Duration**: ${Math.round(s.duration / 1000)}s`]

  if (s.filesModified.length > 0) {
    lines.push(``, `### Files Modified`)
    for (const f of s.filesModified) lines.push(`- ${f}`)
  }

  if (s.filesRead.length > 0) {
    lines.push(``, `### Files Read`)
    for (const f of s.filesRead) lines.push(`- ${f}`)
  }

  return { title, meta, body: lines.join("\n") }
}
