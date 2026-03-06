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

const calls = {
  connect: 0,
  transport: 0,
  close: 0,
}

const state = {
  cfg: {} as Cfg,
  current: undefined as undefined | { status: Record<string, { status: string }>; clients: Record<string, unknown> },
  dispose: undefined as
    | undefined
    | ((value: { status: Record<string, { status: string }>; clients: Record<string, unknown> }) => Promise<void>),
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(_transport: unknown) {
      calls.connect += 1
    }

    setNotificationHandler(_schema: unknown, _fn: unknown) {}

    async listTools() {
      return { tools: [] }
    }

    async close() {
      calls.close += 1
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    stderr = {
      on(_event: string, _handler: (chunk: Buffer) => void) {},
    }

    constructor(_opts: unknown) {
      calls.transport += 1
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
    state: (
      init: () => Promise<{ status: Record<string, { status: string }>; clients: Record<string, unknown> }>,
      dispose?: (value: {
        status: Record<string, { status: string }>
        clients: Record<string, unknown>
      }) => Promise<void>,
    ) => {
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
    calls.connect = 0
    calls.transport = 0
    calls.close = 0
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
    expect(calls.transport).toBe(0)
    expect(calls.connect).toBe(0)
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
    expect(calls.transport).toBe(1)
    expect(calls.connect).toBe(1)
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
    expect(calls.close).toBe(0)
  })
})
