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
const { Config } = await import("../config/config")

describe("MCP.state lazy startup", () => {
  beforeEach(async () => {
    state.calls.connect = 0
    state.calls.transport = 0
    state.calls.close = 0
    state.calls.callTool = 0
    state.delay = 0
    state.mcpTools = []
    state.cfg = {}
    await Instance.disposeAll()
  })

  test("lazy_mcp true registers configured MCPs as pending without connecting", async () => {
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        lazy_local: {
          type: "local",
          command: ["fake-local"],
        },
      },
    }

    const status = await MCP.status()
    expect(status.lazy_local).toEqual({ status: "pending" })
    expect(state.calls.transport).toBe(0)
    expect(state.calls.connect).toBe(0)
  })

  test("lazy_mcp false preserves eager startup behavior", async () => {
    state.cfg = {
      experimental: { lazy_mcp: false },
      mcp: {
        eager_local: {
          type: "local",
          command: ["fake-local"],
        },
      },
    }

    const status = await MCP.status()
    expect(status.eager_local).toEqual({ status: "connected" })
    expect(state.calls.transport).toBe(1)
    expect(state.calls.connect).toBe(1)
  })

  test("metadata is still available for pending MCP entries", async () => {
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        meta_local: {
          type: "local",
          command: ["fake-local", "--arg"],
        },
      },
    }

    const status = await MCP.status()
    const cfg = await Config.get()
    expect(status.meta_local).toEqual({ status: "pending" })
    expect(cfg.mcp?.meta_local).toEqual({
      type: "local",
      command: ["fake-local", "--arg"],
    })
  })

  test("dispose handles pending MCP entries safely", async () => {
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        pending_local: {
          type: "local",
          command: ["fake-local"],
        },
      },
    }

    await MCP.status()
    await expect(Instance.disposeAll()).resolves.toBeUndefined()
    expect(state.calls.close).toBe(0)
  })

  test("connectedTools returns only tools from connected MCP clients", async () => {
    state.cfg = {
      mcp: {
        connected_local: {
          type: "local",
          command: ["fake-local"],
        },
      },
    }
    state.mcpTools = [
      {
        name: "echo",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]

    const result = await MCP.connectedTools()
    expect(Object.keys(result)).toEqual(["connected_local_echo"])
  })

  test("tools returns connected and gateway tools without duplicate IDs", async () => {
    state.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        combined_local: {
          type: "local",
          command: ["fake-local"],
        },
        pending_local: {
          type: "local",
          command: ["fake-local-pending"],
        },
      },
    }
    state.mcpTools = [
      {
        name: "list",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]

    await MCP.status()
    await MCP.connect("combined_local")

    const connected = await MCP.connectedTools()
    const gateway = await MCP.gatewayTools()
    const result = await MCP.tools()
    expect(result.combined_local_list).toBeDefined()
    for (const item of gateway) {
      expect(result[item.id]).toBeDefined()
    }
    expect(Object.keys(result).length).toBe(Object.keys(connected).length + gateway.length)
    expect(new Set(Object.keys(result)).size).toBe(Object.keys(result).length)
  })
})
