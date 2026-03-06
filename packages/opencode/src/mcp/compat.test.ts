import { beforeEach, describe, expect, mock, test } from "bun:test"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"

type Entry = {
  type: "local"
  command: string[]
  enabled?: boolean
  timeout?: number
}

type Cfg = {
  experimental?: {
    lazy_mcp?: boolean
  }
  mcp?: Record<string, Entry>
}

type LocalState = {
  status: Record<string, { status: string; error?: string }>
  clients: Record<string, unknown>
}

type Shared = {
  calls: {
    connect: number
    transport: number
    close: number
    callTool: number
  }
  cfg: Cfg
  mcpTools: { name: string; inputSchema: { type: "object"; properties: Record<string, never> } }[]
  current: undefined | LocalState
  dispose: undefined | ((value: LocalState) => Promise<void>)
  gen: number
  delay: number
  fail: "none" | "unauthorized" | "registration"
  handler: ((...args: unknown[]) => unknown) | undefined
}

const key = "__mcp_mock_state__"
const root = globalThis as typeof globalThis & { [key: string]: Shared | undefined }
const state: Shared =
  root[key] ??
  (root[key] = {
    calls: {
      connect: 0,
      transport: 0,
      close: 0,
      callTool: 0,
    },
    cfg: {},
    mcpTools: [],
    current: undefined,
    dispose: undefined,
    gen: 0,
    delay: 0,
    fail: "none",
    handler: undefined,
  })

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(_transport: unknown) {
      state.calls.connect += 1
      if (state.fail === "unauthorized") throw new UnauthorizedError()
      if (state.fail === "registration") throw new UnauthorizedError("dynamic client registration required")
      if (state.delay === 0) return
      await new Promise((resolve) => setTimeout(resolve, state.delay))
    }

    setNotificationHandler(_schema: unknown, fn: (...args: unknown[]) => unknown) {
      state.handler = fn
    }

    async listTools() {
      return { tools: state.mcpTools }
    }

    async close() {
      state.calls.close += 1
    }

    async callTool() {
      state.calls.callTool += 1
      return {
        content: [],
        isError: false,
      }
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    stderr = {
      on(_event: string, _handler: (chunk: Buffer) => void) {},
    }

    constructor(_opts: unknown) {
      state.calls.transport += 1
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(_url: unknown, _opts?: unknown) {
      state.calls.transport += 1
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(_url: unknown, _opts?: unknown) {
      state.calls.transport += 1
    }
  },
}))

mock.module("./oauth-provider", () => ({
  McpOAuthProvider: class MockOAuthProvider {
    constructor(_key: string, _url: string, _opts?: unknown, _callbacks?: unknown) {}
  },
}))

mock.module("./oauth-callback", () => ({
  McpOAuthCallback: {},
}))

mock.module("./auth", () => ({
  McpAuth: {
    async get() {
      return undefined
    },
    async updateOAuthState() {},
    async getOAuthState() {
      return undefined
    },
    async clearOAuthState() {},
    async clearCodeVerifier() {},
    async remove() {},
    async isTokenExpired() {
      return false
    },
  },
}))

mock.module("../config/config", () => ({
  Config: {
    get: async () => state.cfg,
  },
}))

mock.module("../project/instance", () => ({
  Instance: {
    directory: "/tmp/opencode-test",
    state: (init: () => Promise<LocalState>, dispose?: (value: LocalState) => Promise<void>) => {
      if (dispose !== undefined) state.dispose = dispose
      let cur: LocalState | undefined
      let g = -1
      return async () => {
        if (cur && g === state.gen) return cur
        cur = await init()
        g = state.gen
        if (dispose !== undefined) state.current = cur
        return cur
      }
    },
    async disposeAll() {
      if (state.current && state.dispose) {
        await state.dispose(state.current)
      }
      state.current = undefined
      state.gen++
    },
  },
}))

const { MCP } = await import("./index")
const { Instance } = await import("../project/instance")

function ids(items: Record<string, unknown>) {
  return Object.keys(items).sort()
}

describe("MCP backward compatibility", () => {
  beforeEach(async () => {
    state.calls.connect = 0
    state.calls.transport = 0
    state.calls.close = 0
    state.calls.callTool = 0
    state.cfg = {}
    state.delay = 0
    state.fail = "none"
    state.handler = undefined
    state.mcpTools = [
      {
        name: "echo",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]
    await Instance.disposeAll()
  })

  test("no experimental field behaves exactly like lazy_mcp false", async () => {
    state.cfg = {
      mcp: {
        local: { type: "local", command: ["fake-local"] },
      },
    }

    const baselineStatus = await MCP.status()
    const baselineConnected = await MCP.connectedTools()
    const baselineGateway = await MCP.gatewayTools()

    await Instance.disposeAll()
    state.calls.connect = 0
    state.calls.transport = 0
    state.calls.close = 0
    state.calls.callTool = 0
    state.cfg = {
      experimental: { lazy_mcp: false },
      mcp: {
        local: { type: "local", command: ["fake-local"] },
      },
    }

    const status = await MCP.status()
    const connected = await MCP.connectedTools()
    const gateway = await MCP.gatewayTools()

    expect(baselineStatus).toEqual({ local: { status: "connected" } })
    expect(status).toEqual({ local: { status: "connected" } })
    expect(ids(baselineConnected)).toEqual(["local_echo"])
    expect(ids(connected)).toEqual(ids(baselineConnected))
    expect(gateway).toHaveLength(0)
    expect(gateway).toEqual(baselineGateway)
  })

  test("lazy_mcp false keeps eager behavior with no pending status or gateway tools", async () => {
    state.cfg = {
      experimental: { lazy_mcp: false },
      mcp: {
        local: { type: "local", command: ["fake-local"] },
      },
    }

    const status = await MCP.status()
    const gateway = await MCP.gatewayTools()
    const connected = await MCP.connectedTools()

    expect(status.local).toEqual({ status: "connected" })
    expect(status.local.status).not.toBe("pending")
    expect(state.calls.connect).toBe(1)
    expect(state.calls.transport).toBe(1)
    expect(gateway).toHaveLength(0)
    expect(ids(connected)).toEqual(["local_echo"])
  })

  test("lazy_mcp true starts MCPs pending and exposes gateway tools", async () => {
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        local: { type: "local", command: ["fake-local"] },
      },
    }

    const status = await MCP.status()
    const gateway = await MCP.gatewayTools()
    const connected = await MCP.connectedTools()

    expect(status.local).toEqual({ status: "pending" })
    expect(state.calls.connect).toBe(0)
    expect(state.calls.transport).toBe(0)
    expect(gateway.map((item) => item.id)).toEqual(["mcp_activate_local"])
    expect(ids(connected)).toEqual([])
  })
})
