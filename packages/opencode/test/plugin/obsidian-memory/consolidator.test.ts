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
