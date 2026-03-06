import { beforeEach, describe, expect, mock, test } from "bun:test"

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
  status: Record<string, { status: string }>
  clients: Record<string, unknown>
}

type Shared = {
  calls: {
    connect: number
    transport: number
    close: number
  }
  cfg: Cfg
  mcpTools: { name: string; inputSchema: { type: "object"; properties: Record<string, never> } }[]
  current: undefined | LocalState
  dispose: undefined | ((value: LocalState) => Promise<void>)
  delay: number
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
      state.calls.connect += 1
      if (state.delay === 0) return
      await new Promise((resolve) => setTimeout(resolve, state.delay))
    }

    setNotificationHandler(_schema: unknown, _fn: unknown) {}

    async listTools() {
      return { tools: state.mcpTools }
    }

    async close() {
      state.calls.close += 1
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

describe("MCP.gatewayTools", () => {
  beforeEach(async () => {
    state.calls.connect = 0
    state.calls.transport = 0
    state.calls.close = 0
    state.cfg = {}
    state.delay = 0
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
