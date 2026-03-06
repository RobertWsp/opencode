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
    mcp_timeout?: number
  }
  mcp?: Record<string, Entry>
}

type LocalState = {
  status: Record<string, { status: string; error?: string }>
  clients: Record<string, unknown>
  timers: Record<string, ReturnType<typeof setTimeout>>
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
  fail: "none" | "unauthorized" | "registration"
  handler: ((...args: unknown[]) => unknown) | undefined
}

const key = "__mcp_mock_state__"
type Seed = Partial<Omit<Shared, "calls">> & { calls?: Partial<Shared["calls"]> }

const root = globalThis as typeof globalThis & { [key: string]: Seed | undefined }
const seed = (root[key] ??= {})

seed.calls ??= {}
seed.calls.connect ??= 0
seed.calls.transport ??= 0
seed.calls.close ??= 0
seed.calls.callTool ??= 0
seed.cfg ??= {}
seed.mcpTools ??= []
seed.delay ??= 0
seed.fail ??= "none"
seed.handler ??= undefined

const state = seed as Shared

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
      state.dispose = dispose
      return async () => {
        if (state.current) return state.current
        state.current = await init()
        return state.current
      }
    },
    async disposeAll() {
      if (state.current && state.dispose) {
        await state.dispose(state.current)
      }
      state.current = undefined
      state.dispose = undefined
    },
  },
}))

const { MCP } = await import("./index")
const { Instance } = await import("../project/instance")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("MCP lifecycle", () => {
  beforeEach(async () => {
    state.calls.connect = 0
    state.calls.transport = 0
    state.calls.close = 0
    state.calls.callTool = 0
    state.delay = 0
    state.fail = "none"
    state.handler = undefined
    state.cfg = {}
    state.mcpTools = [
      {
        name: "svc_tool",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]
    await Instance.disposeAll()
  })

  test("full idle timeout lifecycle", async () => {
    state.cfg = {
      experimental: { lazy_mcp: false, mcp_timeout: 80 },
      mcp: {
        svc: { type: "local", command: ["svc"] },
      },
    }

    await MCP.connect("svc")
    let status = await MCP.status()
    expect(status.svc.status).toBe("connected")

    await sleep(120)
    status = await MCP.status()
    expect(status.svc.status).toBe("suspended")

    const gateway = await MCP.gatewayTools()
    const activate = gateway.find((item) => item.id === "mcp_activate_svc")
    expect(activate).toBeDefined()
    const result = await activate!.execute()
    expect(result.tools).toEqual(["svc_tool"])

    status = await MCP.status()
    expect(status.svc.status).toBe("connected")

    await Instance.disposeAll()
    await sleep(140)
    await expect(Instance.disposeAll()).resolves.toBeUndefined()
  })
})
