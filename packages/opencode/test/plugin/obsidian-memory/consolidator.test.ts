import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { parseConsolidatorResponse } from "../../../src/plugin/obsidian-memory/consolidator"

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("parseConsolidatorResponse", () => {
  test("parses an array of mixed operations", () => {
    const raw = JSON.stringify([
      { type: "merge", sources: ["a.md", "b.md"], target_title: "merged", body: "body" },
      { type: "rewrite", path: "c.md", body: "new body" },
      { type: "promote", source: "d.md", reason: "applies globally" },
      { type: "delete", path: "e.md", reason: "noise" },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops).not.toBeNull()
    expect(ops!).toHaveLength(4)
    expect(ops![0].type).toBe("merge")
    expect(ops![1].type).toBe("rewrite")
    expect(ops![2].type).toBe("promote")
    expect(ops![3].type).toBe("delete")
  })

  test("accepts empty array", () => {
    const ops = parseConsolidatorResponse("[]")
    expect(ops).toEqual([])
  })

  test("strips markdown code fences", () => {
    const raw = '```json\n[{"type":"delete","path":"x.md","reason":"r"}]\n```'
    const ops = parseConsolidatorResponse(raw)
    expect(ops).not.toBeNull()
    expect(ops!).toHaveLength(1)
    expect(ops![0].type).toBe("delete")
  })

  test("returns null on invalid JSON", () => {
    expect(parseConsolidatorResponse("not json")).toBeNull()
    expect(parseConsolidatorResponse("{not array}")).toBeNull()
    expect(parseConsolidatorResponse("")).toBeNull()
  })

  test("skips malformed operations but keeps valid ones", () => {
    const raw = JSON.stringify([
      { type: "delete", path: "ok.md", reason: "r" },
      { type: "merge" }, // missing fields
      { type: "unknown", foo: "bar" }, // unknown type
      { type: "rewrite", path: "also-ok.md", body: "b" },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops!).toHaveLength(2)
    expect(ops![0].type).toBe("delete")
    expect(ops![1].type).toBe("rewrite")
  })

  test("merge supports both target and target_title field", () => {
    const rawA = JSON.stringify([
      { type: "merge", sources: ["a.md"], target_title: "t1", body: "b" },
    ])
    const rawB = JSON.stringify([
      { type: "merge", sources: ["a.md"], target: "t2", body: "b" },
    ])
    expect(parseConsolidatorResponse(rawA)!).toHaveLength(1)
    expect(parseConsolidatorResponse(rawB)!).toHaveLength(1)
  })
})

describe("parseConsolidatorResponse — evolve op", () => {
  test("parses evolve with addendum field", () => {
    const raw = JSON.stringify([
      { type: "evolve", path: "notes/a.md", addendum: "new info", reason: "updated" },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops).not.toBeNull()
    expect(ops!).toHaveLength(1)
    expect(ops![0]).toMatchObject({ type: "evolve", path: "notes/a.md", summary: "new info", reason: "updated" })
  })

  test("parses evolve with body field as fallback for addendum", () => {
    const raw = JSON.stringify([
      { type: "evolve", path: "notes/b.md", body: "body content", reason: "r" },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops!).toHaveLength(1)
    expect(ops![0]).toMatchObject({ type: "evolve", summary: "body content" })
  })

  test("addendum takes precedence over body when both present", () => {
    const raw = JSON.stringify([
      { type: "evolve", path: "notes/c.md", addendum: "prefer this", body: "not this", reason: "r" },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops!).toHaveLength(1)
    expect(ops![0]).toMatchObject({ type: "evolve", summary: "prefer this" })
  })

  test("reason defaults to empty string when missing", () => {
    const raw = JSON.stringify([
      { type: "evolve", path: "notes/d.md", addendum: "content" },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops!).toHaveLength(1)
    expect(ops![0]).toMatchObject({ type: "evolve", reason: "" })
  })

  test("rejects evolve with absolute path", () => {
    const raw = JSON.stringify([
      { type: "evolve", path: "/absolute/path.md", addendum: "x", reason: "r" },
    ])
    expect(parseConsolidatorResponse(raw)!).toHaveLength(0)
  })

  test("rejects evolve with path traversal", () => {
    const raw = JSON.stringify([
      { type: "evolve", path: "../outside/vault.md", addendum: "x", reason: "r" },
    ])
    expect(parseConsolidatorResponse(raw)!).toHaveLength(0)
  })

  test("skips evolve missing both addendum and body", () => {
    const raw = JSON.stringify([
      { type: "evolve", path: "ok.md", reason: "r" },
    ])
    expect(parseConsolidatorResponse(raw)!).toHaveLength(0)
  })

  test("skips evolve missing path", () => {
    const raw = JSON.stringify([
      { type: "evolve", addendum: "content", reason: "r" },
    ])
    expect(parseConsolidatorResponse(raw)!).toHaveLength(0)
  })

  test("mixed array keeps valid evolve and other ops", () => {
    const raw = JSON.stringify([
      { type: "delete", path: "gone.md", reason: "noise" },
      { type: "evolve", path: "keep.md", addendum: "extra", reason: "enrich" },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops!).toHaveLength(2)
    expect(ops![0].type).toBe("delete")
    expect(ops![1].type).toBe("evolve")
  })
})

describe("parseConsolidatorResponse — condense op", () => {
  test("parses condense with sources, target and summary", () => {
    const raw = JSON.stringify([
      {
        type: "condense",
        sources: ["notes/sess-1.md", "notes/sess-2.md", "notes/sess-3.md"],
        target: "learned-auth-pattern",
        summary: "auth module always needs jwt refresh",
      },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops).not.toBeNull()
    expect(ops!).toHaveLength(1)
    expect(ops![0]).toMatchObject({
      type: "condense",
      target: "learned-auth-pattern",
      summary: "auth module always needs jwt refresh",
    })
    const op = ops![0] as { type: "condense"; sources: string[] }
    expect(op.sources).toHaveLength(3)
  })

  test("filters absolute paths from sources, keeps valid ones", () => {
    const raw = JSON.stringify([
      {
        type: "condense",
        sources: ["ok.md", "/bad/absolute.md"],
        target: "t",
        summary: "s",
      },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops!).toHaveLength(1)
    const op = ops![0] as { type: "condense"; sources: string[] }
    expect(op.sources).toEqual(["ok.md"])
  })

  test("filters path traversal from sources, keeps valid ones", () => {
    const raw = JSON.stringify([
      {
        type: "condense",
        sources: ["safe.md", "../escape.md"],
        target: "t",
        summary: "s",
      },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops!).toHaveLength(1)
    const op = ops![0] as { type: "condense"; sources: string[] }
    expect(op.sources).toEqual(["safe.md"])
  })

  test("skips condense when all sources are invalid", () => {
    const raw = JSON.stringify([
      { type: "condense", sources: ["/abs.md", "../bad.md"], target: "t", summary: "s" },
    ])
    expect(parseConsolidatorResponse(raw)!).toHaveLength(0)
  })

  test("skips condense when sources is not an array", () => {
    const raw = JSON.stringify([
      { type: "condense", sources: "not-array", target: "t", summary: "s" },
    ])
    expect(parseConsolidatorResponse(raw)!).toHaveLength(0)
  })

  test("skips condense missing target", () => {
    const raw = JSON.stringify([
      { type: "condense", sources: ["a.md"], summary: "s" },
    ])
    expect(parseConsolidatorResponse(raw)!).toHaveLength(0)
  })

  test("skips condense missing summary", () => {
    const raw = JSON.stringify([
      { type: "condense", sources: ["a.md"], target: "t" },
    ])
    expect(parseConsolidatorResponse(raw)!).toHaveLength(0)
  })

  test("mixed array keeps condense alongside other ops", () => {
    const raw = JSON.stringify([
      { type: "delete", path: "gone.md", reason: "noise" },
      {
        type: "condense",
        sources: ["s1.md", "s2.md"],
        target: "learned-pattern",
        summary: "pattern body",
      },
    ])
    const ops = parseConsolidatorResponse(raw)
    expect(ops!).toHaveLength(2)
    expect(ops![0].type).toBe("delete")
    expect(ops![1].type).toBe("condense")
  })
})
