import { describe, it, expect } from "vitest"
import { buildSummary, formatSummaryNote } from "../../../src/plugin/obsidian-memory/session-summary"
import type { CaptureEventInput } from "../../../src/plugin/obsidian-memory/capture-gate"

function ev(tool: string, files: string[], ts = 1000): CaptureEventInput {
  return {
    kind: "tool.after",
    sessionID: "sess-1",
    summary: `ran ${tool}`,
    details: { tool, files },
    timestamp: ts,
  }
}

describe("buildSummary", () => {
  it("returns null for 0 events", () => {
    expect(buildSummary("s1", [], new Set())).toBeNull()
  })

  it("returns null for 1 event", () => {
    expect(buildSummary("s1", [ev("Edit", [])], new Set())).toBeNull()
  })

  it("returns null for 2 events", () => {
    expect(buildSummary("s1", [ev("Edit", []), ev("Write", [])], new Set())).toBeNull()
  })

  it("returns SessionSummary for 3 events", () => {
    const result = buildSummary("s1", [ev("Edit", [], 100), ev("Write", [], 200), ev("bash", [], 300)], new Set())
    expect(result).not.toBeNull()
    expect(result?.sessionID).toBe("s1")
    expect(result?.eventCount).toBe(3)
  })

  it("returns SessionSummary for more than 3 events", () => {
    const events = [ev("Edit", [], 100), ev("Write", [], 200), ev("bash", [], 300), ev("Edit", [], 400)]
    const result = buildSummary("s1", events, new Set())
    expect(result).not.toBeNull()
    expect(result?.eventCount).toBe(4)
  })

  it("collects filesModified from write tools", () => {
    const events = [
      ev("Edit", ["src/foo.ts"], 100),
      ev("Write", ["src/bar.ts"], 200),
      ev("bash", [], 300),
    ]
    const result = buildSummary("s1", events, new Set())
    expect(result?.filesModified).toContain("src/foo.ts")
    expect(result?.filesModified).toContain("src/bar.ts")
  })

  it("collects filesRead from read tools", () => {
    const events = [
      ev("Read", ["src/types.ts"], 100),
      ev("grep", ["src/index.ts"], 200),
      ev("Edit", ["src/foo.ts"], 300),
    ]
    const result = buildSummary("s1", events, new Set())
    expect(result?.filesRead).toContain("src/types.ts")
    expect(result?.filesRead).toContain("src/index.ts")
  })

  it("does not duplicate files across modified and read", () => {
    const events = [
      ev("Edit", ["src/foo.ts"], 100),
      ev("Read", ["src/foo.ts"], 200),
      ev("bash", [], 300),
    ]
    const result = buildSummary("s1", events, new Set())
    const allFiles = [...(result?.filesModified ?? []), ...(result?.filesRead ?? [])]
    const unique = new Set(allFiles)
    expect(unique.size).toBe(allFiles.length)
  })

  it("computes correct duration from first to last event timestamp", () => {
    const events = [ev("Edit", [], 1000), ev("Write", [], 3000), ev("bash", [], 5000)]
    const result = buildSummary("s1", events, new Set())
    expect(result?.duration).toBe(4000)
  })

  it("respects maxNotes by exposing eventCount for caller to check", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev("Edit", [`src/f${i}.ts`], i * 100))
    const result = buildSummary("s1", events, new Set())
    expect(result?.eventCount).toBe(10)
  })

  it("empty sessionFiles with 3 events returns summary with no files from Set", () => {
    const events = [ev("Edit", [], 100), ev("Write", [], 200), ev("bash", [], 300)]
    const result = buildSummary("s1", events, new Set())
    expect(result).not.toBeNull()
    expect(result?.filesModified).toEqual([])
    expect(result?.filesRead).toEqual([])
  })

  it("sessionFiles adds files not captured in events to filesRead", () => {
    const events = [ev("Edit", ["src/foo.ts"], 100), ev("Write", [], 200), ev("bash", [], 300)]
    const extra = new Set(["src/extra.ts"])
    const result = buildSummary("s1", events, extra)
    expect(result?.filesRead).toContain("src/extra.ts")
  })

  it("stores the correct sessionID", () => {
    const events = [ev("Edit", [], 100), ev("Write", [], 200), ev("bash", [], 300)]
    const result = buildSummary("my-session-abc", events, new Set())
    expect(result?.sessionID).toBe("my-session-abc")
  })
})

describe("formatSummaryNote", () => {
  const base = {
    sessionID: "abc123def456",
    filesModified: [],
    filesRead: [],
    eventCount: 5,
    duration: 3000,
  }

  it("sets memory-kind to session-summary in meta", () => {
    const result = formatSummaryNote(base)
    expect(result.meta["memory-kind"]).toBe("session-summary")
  })

  it("includes eventCount in title", () => {
    const result = formatSummaryNote(base)
    expect(result.title).toContain("5")
  })

  it("includes filesModified in body", () => {
    const result = formatSummaryNote({ ...base, filesModified: ["src/auth.ts", "src/config.ts"] })
    expect(result.body).toContain("src/auth.ts")
    expect(result.body).toContain("src/config.ts")
  })

  it("includes filesRead in body", () => {
    const result = formatSummaryNote({ ...base, filesRead: ["src/types.ts"] })
    expect(result.body).toContain("src/types.ts")
  })

  it("returns non-empty title", () => {
    const result = formatSummaryNote(base)
    expect(result.title.length).toBeGreaterThan(0)
  })

  it("returns non-empty body", () => {
    const result = formatSummaryNote(base)
    expect(result.body.length).toBeGreaterThan(0)
  })

  it("meta contains session-id", () => {
    const result = formatSummaryNote(base)
    expect(result.meta["session-id"]).toBe("abc123def456")
  })

  it("meta contains event-count as string", () => {
    const result = formatSummaryNote(base)
    expect(result.meta["event-count"]).toBe("5")
  })
})
