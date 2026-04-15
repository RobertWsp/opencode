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
      [],
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
      [],
    )
    expect(msg).not.toContain("User's last intent")
    expect(msg).toContain("Tool events (1)")
    expect(msg).toContain("bash failed")
  })

  test("includes candidates when provided", () => {
    const msg = __internal.buildGateUserMessage(
      [{ kind: "tool.after", sessionID: "s", summary: "x", timestamp: 0 }],
      "doing auth",
      [
        {
          id: "cand_0",
          title: "auth bug gotcha",
          description: "JWT expiry",
          tags: ["auth"],
        },
      ],
    )
    expect(msg).toContain("Existing candidates")
    expect(msg).toContain("cand_0")
    expect(msg).toContain("auth bug gotcha")
    expect(msg).toContain("#auth")
  })
})

describe("parseGateResponse — new 4-op schema", () => {
  test("parses ADD with all fields", () => {
    const raw = JSON.stringify({
      op: "ADD",
      reason: "new gotcha",
      kind: "gotcha",
      title: "jwt-expiry",
      body: "Tokens expire after 1h",
      tags: ["auth", "jwt"],
      links: ["auth overview"],
      importance: 0.8,
    })
    const decision = parseGateResponse(raw)
    expect(decision).not.toBeNull()
    expect(decision!.op).toBe("ADD")
    expect(decision!.kind).toBe("gotcha")
    expect(decision!.tags).toEqual(["auth", "jwt"])
    expect(decision!.links).toEqual(["auth overview"])
    expect(decision!.importance).toBe(0.8)
  })

  test("parses UPDATE with targetId", () => {
    const raw = JSON.stringify({
      op: "UPDATE",
      targetId: "cand_2",
      reason: "adds new info",
      kind: "fact",
      title: "merged",
      body: "new body",
      tags: [],
      links: [],
      importance: 0.6,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.op).toBe("UPDATE")
    expect(decision!.targetId).toBe("cand_2")
  })

  test("parses DELETE with supersedes", () => {
    const raw = JSON.stringify({
      op: "DELETE",
      targetId: "cand_0",
      reason: "obsolete after v5 migration",
      kind: "fact",
      title: "",
      body: "",
      tags: [],
      links: [],
      supersedes: "zustand-v5",
      importance: 0.3,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.op).toBe("DELETE")
    expect(decision!.supersedes).toBe("zustand-v5")
  })

  test("parses NOOP with only op and reason", () => {
    const decision = parseGateResponse(JSON.stringify({ op: "NOOP", reason: "routine" }))
    expect(decision!.op).toBe("NOOP")
    expect(decision!.reason).toBe("routine")
    expect(decision!.tags).toEqual([])
    expect(decision!.links).toEqual([])
  })

  test("back-compat: old save=true → ADD", () => {
    const raw = JSON.stringify({
      save: true,
      reason: "x",
      title: "y",
      body: "z",
      tags: [],
      importance: 0.5,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.op).toBe("ADD")
    expect(decision!.title).toBe("y")
  })

  test("back-compat: old save=false → NOOP", () => {
    const decision = parseGateResponse(JSON.stringify({ save: false, reason: "routine" }))
    expect(decision!.op).toBe("NOOP")
  })

  test("strips markdown code fences", () => {
    const raw = '```json\n{"op": "ADD", "kind": "fact", "title": "t", "body": "b", "tags": [], "links": [], "importance": 0.5}\n```'
    const decision = parseGateResponse(raw)
    expect(decision!.op).toBe("ADD")
  })

  test("returns null on malformed JSON", () => {
    expect(parseGateResponse("not json")).toBeNull()
    expect(parseGateResponse("")).toBeNull()
    expect(parseGateResponse("{incomplete")).toBeNull()
  })

  test("returns null when op is invalid", () => {
    expect(parseGateResponse(JSON.stringify({ op: "UPSERT" }))).toBeNull()
    expect(parseGateResponse(JSON.stringify({}))).toBeNull()
  })

  test("filters non-string tags and links", () => {
    const raw = JSON.stringify({
      op: "ADD",
      kind: "fact",
      title: "t",
      body: "b",
      tags: ["valid", 42, null, "also-valid"],
      links: ["ok", 99, "also-ok"],
      importance: 0.5,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.tags).toEqual(["valid", "also-valid"])
    expect(decision!.links).toEqual(["ok", "also-ok"])
  })

  test("defaults kind to 'fact' when missing or invalid", () => {
    expect(
      parseGateResponse(JSON.stringify({ op: "ADD", title: "t", body: "b" }))!.kind,
    ).toBe("fact")
    expect(
      parseGateResponse(JSON.stringify({ op: "ADD", kind: "nonsense", title: "t", body: "b" }))!
        .kind,
    ).toBe("fact")
  })
})
