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
    mcp_timeout?: number
  }
  mcp?: Record<string, Entry>
}

type LocalState = {
  status: Record<string, { status: string; error?: string }>
  clients: Record<string, unknown>
  timers: Record<string, ReturnType<typeof setTimeout>>
  debounce?: ReturnType<typeof setTimeout>
}

type Shared = {
  calls: {
    connect: number
    transport: number
    close: number
    callTool: number
    publish: number
  }
  cfg: Cfg
  mcpTools: { name: string; inputSchema: { type: "object"; properties: Record<string, never> } }[]
  current: undefined | LocalState
  dispose: undefined | ((value: LocalState) => Promise<void>)
  disposers: Array<(value: any) => Promise<void>>
  gen: number
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
seed.calls.publish ??= 0
seed.cfg ??= {}
seed.mcpTools ??= []
seed.disposers ??= []
seed.gen ??= 0
seed.delay ??= 0
seed.fail ??= "none"
seed.handler ??= undefined

const shared = seed as Shared

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(_transport: unknown) {
      shared.calls.connect += 1
      if (shared.fail === "unauthorized") throw new UnauthorizedError()
      if (shared.fail === "registration") throw new UnauthorizedError("dynamic client registration required")
      if (shared.delay === 0) return
      await new Promise((resolve) => setTimeout(resolve, shared.delay))
    }

    setNotificationHandler(_schema: unknown, fn: (...args: unknown[]) => unknown) {
      shared.handler = fn
    }

    async listTools() {
      return { tools: shared.mcpTools }
    }

    async close() {
      shared.calls.close += 1
    }

    async callTool() {
      shared.calls.callTool += 1
      return { content: [], isError: false }
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioTransport {
    stderr = { on() {} }
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
    constructor() {}
  },
}))

mock.module("./oauth-callback", () => ({ McpOAuthCallback: {} }))

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
  Config: { get: async () => shared.cfg },
}))

mock.module("@/bus", () => ({
  Bus: {
    subscribe: () => () => {},
    async publish() {
      shared.calls.publish += 1
    },
  },
}))

mock.module("../project/instance", () => ({
  Instance: {
    directory: "/tmp/opencode-test",
    state: (init: () => Promise<LocalState>, dispose?: (value: any) => Promise<void>) => {
      if (dispose !== undefined) shared.dispose = dispose
      if (dispose) shared.disposers.push(dispose)
      let cur: LocalState | undefined
      let g = -1
      return async () => {
        if (cur && g === shared.gen) return cur
        cur = await init()
        g = shared.gen
        if (dispose !== undefined) shared.current = cur
        return cur
      }
    },
    async disposeAll() {
      if (shared.current) {
        if (shared.disposers.length > 0) {
          for (const fn of shared.disposers) await fn(shared.current)
        } else if (shared.current.debounce) {
          clearTimeout(shared.current.debounce)
          shared.current.debounce = undefined
        }
        for (const client of Object.values(shared.current.clients ?? {}))
          await (client as any).close?.().catch(() => {})
      }
      shared.current = undefined
      shared.gen++
    },
  },
}))

const { MCP } = await import("./index")
const { Instance } = await import("../project/instance")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function notify() {
  if (!shared.handler) throw new Error("notification handler not registered")
  return shared.handler()
}

describe("ToolsChanged debounce", () => {
  beforeEach(async () => {
    shared.calls.connect = 0
    shared.calls.transport = 0
    shared.calls.close = 0
    shared.calls.callTool = 0
    shared.calls.publish = 0
    shared.delay = 0
    shared.cfg = {}
    shared.fail = "none"
    shared.handler = undefined
    shared.mcpTools = [{ name: "debounce_tool", inputSchema: { type: "object", properties: {} } }]
    await Instance.disposeAll()
  })

  test("suppressed while gateway activation is in progress", async () => {
    shared.cfg = {
      experimental: { lazy_mcp: true },
      mcp: {
        eager: { type: "local", command: ["eager"] },
        slow: { type: "local", command: ["slow"] },
      },
    }

    await MCP.status()

    shared.delay = 0
    await MCP.connect("eager")
    expect(shared.handler).toBeDefined()

    const before = shared.calls.publish

    shared.delay = 200
    const tools = await MCP.gatewayTools()
    const gateway = tools.find((t) => t.id === "mcp_activate_slow")!
    const pending = gateway.execute()
    await sleep(30)

    await notify()

    expect(shared.current!.debounce).toBeUndefined()
    expect(shared.calls.publish).toBe(before)

    await pending
  })

  test("processes after gateway activation completes", async () => {
    shared.cfg = {
      mcp: { quick: { type: "local", command: ["quick"] } },
    }

    await MCP.status()

    const before = shared.calls.publish
    await notify()

    expect(shared.current!.debounce).toBeDefined()

    await sleep(600)

    expect(shared.current!.debounce).toBeUndefined()
    expect(shared.calls.publish).toBe(before + 1)
  })

  test("rapid events debounced to single publish", async () => {
    shared.cfg = {
      mcp: { rapid: { type: "local", command: ["rapid"] } },
    }

    await MCP.status()

    const before = shared.calls.publish

    await notify()
    await notify()
    await notify()

    expect(shared.current!.debounce).toBeDefined()

    await sleep(600)

    expect(shared.calls.publish).toBe(before + 1)
    expect(shared.current!.debounce).toBeUndefined()
  })

  test("dispose clears debounce timer preventing stale callback", async () => {
    shared.cfg = {
      mcp: { disposed: { type: "local", command: ["disposed"] } },
    }

    await MCP.status()

    const before = shared.calls.publish
    await notify()

    expect(shared.current!.debounce).toBeDefined()

    await Instance.disposeAll()

    await sleep(600)

    expect(shared.calls.publish).toBe(before)
  })
})
