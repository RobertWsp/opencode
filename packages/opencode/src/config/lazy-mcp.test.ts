import { describe, it, expect } from "bun:test"
import { Config } from "./config"

describe("Config.Info experimental.lazy_mcp", () => {
  it("should parse config with experimental.lazy_mcp=true", () => {
    const input = {
      experimental: {
        lazy_mcp: true,
      },
    }
    const result = Config.Info.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.experimental?.lazy_mcp).toBe(true)
    }
  })

  it("should parse config with experimental.lazy_mcp=false", () => {
    const input = {
      experimental: {
        lazy_mcp: false,
      },
    }
    const result = Config.Info.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.experimental?.lazy_mcp).toBe(false)
    }
  })

  it("should default lazy_mcp to false when experimental field is missing", () => {
    const input = {}
    const result = Config.Info.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      // experimental defaults to {}, so lazy_mcp will be undefined (not explicitly set)
      expect(result.data.experimental?.lazy_mcp).toBeUndefined()
    }
  })

  it("should allow lazy_mcp to be undefined when experimental exists but lazy_mcp is missing", () => {
    const input = {
      experimental: {
        batch_tool: true,
      },
    }
    const result = Config.Info.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.experimental?.lazy_mcp).toBeUndefined()
    }
  })

  it("should parse existing config without experimental field (backward compat)", () => {
    const input = {
      model: "anthropic/claude-opus",
    }
    const result = Config.Info.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.model).toBe("anthropic/claude-opus")
      expect(result.data.experimental?.lazy_mcp).toBeUndefined()
    }
  })

  it("should reject non-boolean lazy_mcp value", () => {
    const input = {
      experimental: {
        lazy_mcp: "true",
      },
    }
    const result = Config.Info.safeParse(input)
    expect(result.success).toBe(false)
  })
})
