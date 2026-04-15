import { describe, expect, test } from "bun:test"
import {
  __internal,
  parseGateResponse,
} from "../../../src/plugin/obsidian-memory/capture-gate"

describe("isTrivial pre-filter", () => {
  test("drops trivial read tools", () => {
    for (const tool of ["ls", "glob", "grep", "read", "codesearch", "webfetch"]) {
      expect(
        __internal.isTrivial({
          kind: "tool.after",
          sessionID: "s",
          summary: tool,
          details: { tool },
          timestamp: 0,
        }),
      ).toBe(true)
    }
  })

  test("keeps non-trivial tools", () => {
    for (const tool of ["edit", "write", "bash", "patch", "task"]) {
      expect(
        __internal.isTrivial({
          kind: "tool.after",
          sessionID: "s",
          summary: tool,
          details: { tool },
          timestamp: 0,
        }),
      ).toBe(false)
    }
  })

  test("always keeps session.error", () => {
    expect(
      __internal.isTrivial({
        kind: "session.error",
        sessionID: "s",
        summary: "boom",
        timestamp: 0,
      }),
    ).toBe(false)
  })
})

describe("buildGateUserMessage", () => {
  test("includes user prompt when provided", () => {
    const msg = __internal.buildGateUserMessage(
      [
        {
          kind: "tool.after",
          sessionID: "s",
          summary: "edit src/foo.ts",
          details: { tool: "edit" },
          timestamp: 0,
        },
      ],
      "fix the auth bug",
    )
    expect(msg).toContain("User's last intent")
    expect(msg).toContain("fix the auth bug")
    expect(msg).toContain("Tool events (1)")
    expect(msg).toContain("edit src/foo.ts")
  })

  test("works without user prompt", () => {
    const msg = __internal.buildGateUserMessage(
      [
        {
          kind: "tool.after",
          sessionID: "s",
          summary: "bash failed",
          timestamp: 0,
        },
      ],
      undefined,
    )
    expect(msg).not.toContain("User's last intent")
    expect(msg).toContain("Tool events (1)")
    expect(msg).toContain("bash failed")
  })
})

describe("parseGateResponse", () => {
  test("parses save=true with all fields", () => {
    const raw = JSON.stringify({
      save: true,
      reason: "novel gotcha",
      title: "foo-gotcha",
      body: "multi\nline",
      tags: ["build", "auth"],
      importance: 0.8,
    })
    const decision = parseGateResponse(raw)
    expect(decision).not.toBeNull()
    expect(decision!.save).toBe(true)
    expect(decision!.title).toBe("foo-gotcha")
    expect(decision!.tags).toEqual(["build", "auth"])
    expect(decision!.importance).toBe(0.8)
  })

  test("parses save=false with only reason", () => {
    const decision = parseGateResponse(JSON.stringify({ save: false, reason: "routine" }))
    expect(decision).not.toBeNull()
    expect(decision!.save).toBe(false)
    expect(decision!.reason).toBe("routine")
    expect(decision!.tags).toEqual([])
  })

  test("strips markdown code fences", () => {
    const raw = '```json\n{"save": true, "title": "t", "body": "b", "tags": [], "importance": 0.5}\n```'
    const decision = parseGateResponse(raw)
    expect(decision).not.toBeNull()
    expect(decision!.save).toBe(true)
    expect(decision!.title).toBe("t")
  })

  test("returns null on malformed JSON", () => {
    expect(parseGateResponse("not json")).toBeNull()
    expect(parseGateResponse("")).toBeNull()
    expect(parseGateResponse("{incomplete")).toBeNull()
  })

  test("returns null when save field is missing or wrong type", () => {
    expect(parseGateResponse(JSON.stringify({ reason: "no save field" }))).toBeNull()
    expect(parseGateResponse(JSON.stringify({ save: "yes" }))).toBeNull()
  })

  test("filters non-string tags", () => {
    const raw = JSON.stringify({
      save: true,
      reason: "",
      title: "t",
      body: "b",
      tags: ["valid", 42, null, "also-valid"],
      importance: 0.5,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.tags).toEqual(["valid", "also-valid"])
  })
})
