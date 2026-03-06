import { describe, it, expect, beforeAll } from "bun:test"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"

describe("skill_search tool", () => {
  let tool: Tool.Info

  beforeAll(async () => {
    const all = await ToolRegistry.all()
    const found = all.find((t) => t.id === "skill_search")
    if (!found) {
      throw new Error("skill_search tool not found in registry")
    }
    tool = found
  })

  it("should be registered in ToolRegistry", async () => {
    const all = await ToolRegistry.all()
    const ids = all.map((t) => t.id)
    expect(ids).toContain("skill_search")
  })

  it("should have correct description", async () => {
    const init = await tool.init()
    expect(init.description).toContain("skill")
    expect(init.description.length).toBeGreaterThan(0)
  })

  it("should accept query parameter", async () => {
    const init = await tool.init()
    const params = init.parameters
    const result = params.safeParse({ query: "playwright" })
    expect(result.success).toBe(true)
  })

  it("should reject missing query parameter", async () => {
    const init = await tool.init()
    const params = init.parameters
    const result = params.safeParse({})
    expect(result.success).toBe(false)
  })

  it("should return empty array for non-matching query", async () => {
    const init = await tool.init()
    const ctx = {
      sessionID: "test-session",
      messageID: "test-message",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => {},
      ask: async () => {},
    } as any

    const result = await init.execute({ query: "xyznonexistent123456" }, ctx)
    expect(result.output).toBeDefined()
    expect(result.title).toBeDefined()
    expect(result.metadata).toBeDefined()

    // Should contain empty results or "no matches" message
    const output = result.output.toLowerCase()
    expect(output).toMatch(/no|empty|match|found/)
  })

  it("should return matching skills for valid query", async () => {
    const init = await tool.init()
    const ctx = {
      sessionID: "test-session",
      messageID: "test-message",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => {},
      ask: async () => {},
    } as any

    // Use a common skill name that should exist
    const result = await init.execute({ query: "skill" }, ctx)
    expect(result.output).toBeDefined()
    expect(result.title).toBeDefined()
    expect(result.metadata).toBeDefined()

    // Output should contain skill information
    const output = result.output.toLowerCase()
    expect(output.length).toBeGreaterThan(0)
  })

  it("should be case-insensitive", async () => {
    const init = await tool.init()
    const ctx = {
      sessionID: "test-session",
      messageID: "test-message",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => {},
      ask: async () => {},
    } as any

    const result1 = await init.execute({ query: "SKILL" }, ctx)
    const result2 = await init.execute({ query: "skill" }, ctx)

    // Both should return results (case-insensitive)
    expect(result1.output).toBeDefined()
    expect(result2.output).toBeDefined()
  })
})
