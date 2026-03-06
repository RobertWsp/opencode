import { beforeEach, describe, expect, mock, test } from "bun:test"

type Entry = {
  type: "local"
  command: string[]
  enabled?: boolean
  timeout?: number
}

type Cfg = {
  experimental?: {
    mcp_timeout?: number
  }
  mcp?: Record<string, Entry>
}

type LocalState = {
  status: Record<string, { status: string }>
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

    async callTool() {
      state.calls.callTool += 1
      return {
        content: [],
        isError: false,
      }
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("MCP idle timeout", () => {
  beforeEach(async () => {
    state.calls.connect = 0
    state.calls.transport = 0
    state.calls.close = 0
    state.calls.callTool = 0
    state.delay = 0
    state.cfg = {}
    state.mcpTools = [
      {
        name: "idle_tool",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]
    await Instance.disposeAll()
  })

  test("suspends and closes MCP after idle timeout", async () => {
    state.cfg = {
      experimental: { mcp_timeout: 50 },
      mcp: {
        idle: { type: "local", command: ["idle"] },
      },
    }

    await MCP.status()
    await sleep(80)

    const status = await MCP.status()
    expect(status.idle).toEqual({ status: "suspended" })
    expect(state.calls.close).toBe(1)
  })

  test("tool call resets idle timer", async () => {
    state.cfg = {
      experimental: { mcp_timeout: 60 },
      mcp: {
        idle: { type: "local", command: ["idle"] },
      },
    }

    await MCP.status()
    await sleep(40)

    const all = await MCP.connectedTools()
    const tool = all.idle_idle_tool
    if (!tool?.execute) throw new Error("missing execute")
    await tool.execute({}, { toolCallId: "t1", messages: [] })
    await sleep(40)

    expect((await MCP.status()).idle).toEqual({ status: "connected" })

    await sleep(40)
    expect((await MCP.status()).idle).toEqual({ status: "suspended" })
    expect(state.calls.callTool).toBe(1)
  })

  test("dispose clears idle timers", async () => {
    state.cfg = {
      experimental: { mcp_timeout: 40 },
      mcp: {
        idle: { type: "local", command: ["idle"] },
      },
    }

    await MCP.status()
    await Instance.disposeAll()
    await sleep(70)

    expect(state.calls.close).toBe(1)
  })

  test("idle disconnect sets suspended status", async () => {
    state.cfg = {
      experimental: { mcp_timeout: 40 },
      mcp: {
        idle: { type: "local", command: ["idle"] },
      },
    }

    await MCP.status()
    await sleep(70)

    expect((await MCP.status()).idle).toEqual({ status: "suspended" })
    expect((await MCP.status()).idle).not.toEqual({ status: "disabled" })
  })

  test("suspended MCP can be reactivated through gateway tool", async () => {
    state.cfg = {
      experimental: { mcp_timeout: 40 },
      mcp: {
        idle: { type: "local", command: ["idle"] },
      },
    }

    await MCP.status()
    await sleep(70)
    expect((await MCP.status()).idle).toEqual({ status: "suspended" })

    const list = await MCP.gatewayTools()
    const tool = list.find((item) => item.id === "mcp_activate_idle")
    expect(tool).toBeDefined()
    const result = await tool!.execute()

    expect(result.tools).toEqual(["idle_tool"])
    expect((await MCP.status()).idle).toEqual({ status: "connected" })
  })
})
