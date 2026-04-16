import { describe, it, expect } from "bun:test"
import { MCP } from "./index"

describe("MCP.Status", () => {
  it("should parse 'connected' status", () => {
    const result = MCP.Status.safeParse({ status: "connected" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("connected")
    }
  })

  it("should parse 'disabled' status", () => {
    const result = MCP.Status.safeParse({ status: "disabled" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("disabled")
    }
  })

  it("should parse 'failed' status with error", () => {
    const result = MCP.Status.safeParse({ status: "failed", error: "Connection timeout" })
    expect(result.success).toBe(true)
    if (result.success && result.data.status === "failed") {
      expect(result.data.status).toBe("failed")
      expect(result.data.error).toBe("Connection timeout")
    }
  })

  it("should parse 'needs_auth' status", () => {
    const result = MCP.Status.safeParse({ status: "needs_auth" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("needs_auth")
    }
  })

  it("should parse 'needs_client_registration' status with error", () => {
    const result = MCP.Status.safeParse({ status: "needs_client_registration", error: "Invalid client" })
    expect(result.success).toBe(true)
    if (result.success && result.data.status === "needs_client_registration") {
      expect(result.data.status).toBe("needs_client_registration")
      expect(result.data.error).toBe("Invalid client")
    }
  })

  it("should parse 'pending' status", () => {
    const result = MCP.Status.safeParse({ status: "pending" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("pending")
    }
  })

  it("should parse 'suspended' status", () => {
    const result = MCP.Status.safeParse({ status: "suspended" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("suspended")
    }
  })

  it("should reject invalid status", () => {
    const result = MCP.Status.safeParse({ status: "invalid" })
    expect(result.success).toBe(false)
  })

  it("should reject 'failed' without error field", () => {
    const result = MCP.Status.safeParse({ status: "failed" })
    expect(result.success).toBe(false)
  })

  it("should reject 'needs_client_registration' without error field", () => {
    const result = MCP.Status.safeParse({ status: "needs_client_registration" })
    expect(result.success).toBe(false)
  })
})
