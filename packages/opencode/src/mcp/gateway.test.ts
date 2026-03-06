import { beforeEach, describe, expect, mock, test } from "bun:test"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"

type LocalEntry = {
  type: "local"
  command: string[]
  enabled?: boolean
  timeout?: number
}

type RemoteEntry = {
  type: "remote"
  url: string
  enabled?: boolean
  timeout?: number
  oauth?: boolean | { clientId?: string }
}

type Entry = LocalEntry | RemoteEntry

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

describe("MCP.gatewayTools", () => {
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
        name: "mock_tool",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]
    await Instance.disposeAll()
  })

  test("returns one gateway tool per pending MCP", async () => {
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        github: { type: "local", command: ["github"] },
        slack: { type: "local", command: ["slack"] },
        off: { type: "local", command: ["off"], enabled: false },
      },
    }

    const tools = await MCP.gatewayTools()
    expect(tools.map((item) => item.id).sort()).toEqual(["mcp_activate_github", "mcp_activate_slack"])
  })

  test("execute activates pending MCP and returns available tool names", async () => {
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        github: { type: "local", command: ["github"] },
      },
    }

    const tools = await MCP.gatewayTools()
    const activate = tools.find((item) => item.id === "mcp_activate_github")
    expect(activate).toBeDefined()
    const result = await activate!.execute()
    expect(result.tools).toEqual(["mock_tool"])
    expect((await MCP.status()).github).toEqual({ status: "connected" })
  })

  test("after activation, gatewayTools no longer includes that MCP", async () => {
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        github: { type: "local", command: ["github"] },
      },
    }

    const first = await MCP.gatewayTools()
    await first[0].execute()
    const second = await MCP.gatewayTools()
    expect(second).toHaveLength(0)
  })

  test("concurrent calls to same gateway tool only connect once", async () => {
    state.delay = 25
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        github: { type: "local", command: ["github"] },
      },
    }

    const tools = await MCP.gatewayTools()
    const activate = tools.find((item) => item.id === "mcp_activate_github")!
    const [a, b] = await Promise.all([activate.execute(), activate.execute()])

    expect(a.tools).toEqual(["mock_tool"])
    expect(b.tools).toEqual(["mock_tool"])
    expect(state.calls.connect).toBe(1)
    expect(state.calls.transport).toBe(1)
    expect((await MCP.status()).github).toEqual({ status: "connected" })
  })
})

describe("OAuth gateway activation", () => {
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
        name: "remote_tool",
        inputSchema: { type: "object", properties: {} },
      },
    ]
    await Instance.disposeAll()
  })

  test("returns actionable auth message for needs_auth remote MCP", async () => {
    state.fail = "unauthorized"
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        acme: { type: "remote", url: "https://acme.example.com/mcp" },
      },
    }

    const tools = await MCP.gatewayTools()
    const activate = tools.find((t) => t.id === "mcp_activate_acme")
    expect(activate).toBeDefined()

    const result = await activate!.execute()
    expect(result.tools).toHaveLength(0)
    expect(result.error).toContain("opencode mcp auth acme")
    expect(result.error).toContain("AUTH REQUIRED")
  })

  test("sets status to needs_auth after OAuth failure", async () => {
    state.fail = "unauthorized"
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        acme: { type: "remote", url: "https://acme.example.com/mcp" },
      },
    }

    const tools = await MCP.gatewayTools()
    await tools[0].execute()

    const status = await MCP.status()
    expect(status.acme).toBeDefined()
    expect(status.acme.status).toBe("needs_auth")
  })

  test("does not crash on OAuth failure", async () => {
    state.fail = "unauthorized"
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        acme: { type: "remote", url: "https://acme.example.com/mcp" },
      },
    }

    const tools = await MCP.gatewayTools()
    const result = await tools[0].execute()
    expect(result).toBeDefined()
    expect(result.tools).toBeDefined()
  })

  test("needs_auth MCP excluded from subsequent gatewayTools calls", async () => {
    state.fail = "unauthorized"
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        acme: { type: "remote", url: "https://acme.example.com/mcp" },
      },
    }

    const first = await MCP.gatewayTools()
    await first[0].execute()

    const second = await MCP.gatewayTools()
    expect(second).toHaveLength(0)
  })

  test("returns client registration message for needs_client_registration", async () => {
    state.fail = "registration"
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        corp: { type: "remote", url: "https://corp.example.com/mcp" },
      },
    }

    const tools = await MCP.gatewayTools()
    const result = await tools[0].execute()
    expect(result.tools).toHaveLength(0)
    expect(result.error).toContain("AUTH REQUIRED")
    expect(result.error).toContain("clientId")
  })
})
