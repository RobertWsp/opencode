import { beforeEach, describe, expect, mock, test } from "bun:test"

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
  delay: number
}

const key = "__mcp_mock_state__"
const root = globalThis as typeof globalThis & { [key: string]: Shared | undefined }
const shared: Shared =
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
    delay: 0,
  })

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(_transport: unknown) {
      shared.calls.connect += 1
      if (shared.delay === 0) return
      await new Promise((resolve) => setTimeout(resolve, shared.delay))
    }

    setNotificationHandler(_schema: unknown, _fn: (...args: unknown[]) => unknown) {}

    async listTools() {
      return { tools: shared.mcpTools }
    }

    async close() {
      shared.calls.close += 1
    }

    async callTool() {
      shared.calls.callTool += 1
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
      shared.calls.transport += 1
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(_url: unknown, _opts?: unknown) {
      shared.calls.transport += 1
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(_url: unknown, _opts?: unknown) {
      shared.calls.transport += 1
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
    get: async () => shared.cfg,
  },
}))

mock.module("../project/instance", () => ({
  Instance: {
    directory: "/tmp/opencode-test",
    state: (init: () => Promise<LocalState>, dispose?: (value: LocalState) => Promise<void>) => {
      shared.dispose = dispose
      return async () => {
        if (shared.current) return shared.current
        shared.current = await init()
        return shared.current
      }
    },
    async disposeAll() {
      if (shared.current && shared.dispose) {
        await shared.dispose(shared.current)
      }
      shared.current = undefined
      shared.dispose = undefined
    },
  },
}))

const { MCP } = await import("./index")
const { Instance } = await import("../project/instance")

describe("MCP concurrent gateway activation", () => {
  beforeEach(async () => {
    shared.calls.connect = 0
    shared.calls.transport = 0
    shared.calls.close = 0
    shared.calls.callTool = 0
    shared.cfg = {}
    shared.delay = 0
    shared.mcpTools = [
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

  test("concurrent calls to same MCP connect only once", async () => {
    shared.delay = 25
    shared.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        "mcp-a": { type: "local", command: ["alpha"] },
      },
    }

    await MCP.status()
    const all = await MCP.gatewayTools()
    const a = all.find((item) => item.id === "mcp_activate_mcp-a")
    expect(a).toBeDefined()

    const before = shared.calls.connect
    const [r1, r2] = await Promise.all([a!.execute(), a!.execute()])

    expect(shared.calls.connect - before).toBe(1)
    expect(r1.tools).toEqual(["mock_tool"])
    expect(r2.tools).toEqual(["mock_tool"])
    expect((await MCP.status())["mcp-a"]).toEqual({ status: "connected" })
  })

  test("concurrent calls to different MCPs connect independently", async () => {
    shared.delay = 25
    shared.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        "mcp-a": { type: "local", command: ["alpha"] },
        "mcp-b": { type: "local", command: ["beta"] },
      },
    }

    await MCP.status()
    const all = await MCP.gatewayTools()
    const a = all.find((item) => item.id === "mcp_activate_mcp-a")
    const b = all.find((item) => item.id === "mcp_activate_mcp-b")
    expect(a).toBeDefined()
    expect(b).toBeDefined()

    const before = shared.calls.connect
    const [r1, r2] = await Promise.all([a!.execute(), b!.execute()])

    expect(shared.calls.connect - before).toBe(2)
    expect(r1.tools).toEqual(["mock_tool"])
    expect(r2.tools).toEqual(["mock_tool"])
    expect((await MCP.status())["mcp-a"]).toEqual({ status: "connected" })
    expect((await MCP.status())["mcp-b"]).toEqual({ status: "connected" })
  })
})
