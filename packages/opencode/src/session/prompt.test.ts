import { beforeEach, describe, expect, mock, test } from "bun:test"
import { jsonSchema } from "ai"
import z from "zod"

type Cfg = {
  experimental?: {
    lazy_mcp?: boolean
  }
}

type Event = {
  event: string
  meta: Record<string, unknown>
  payload: Record<string, unknown>
}

type Ask = {
  permission: string
}

type McpTool = {
  description: string
  inputSchema: ReturnType<typeof jsonSchema>
  execute?: (
    args: unknown,
    opts: { toolCallId: string },
  ) => Promise<{
    content: { type: "text"; text: string }[]
    metadata?: Record<string, unknown>
  }>
}

type Shared = {
  cfg: Cfg
  connected: Record<string, McpTool>
  all: Record<string, McpTool>
  calls: {
    connected: number
    tools: number
  }
  events: Event[]
  asks: Ask[]
}

const key = "__session_prompt_tools__"
const root = globalThis as typeof globalThis & { [key: string]: Shared | undefined }
const state: Shared =
  root[key] ??
  (root[key] = {
    cfg: {},
    connected: {},
    all: {},
    calls: {
      connected: 0,
      tools: 0,
    },
    events: [],
    asks: [],
  })

mock.module("../config/config", () => ({
  Config: {
    get: async () => state.cfg,
  },
}))

mock.module("../tool/registry", () => ({
  ToolRegistry: {
    tools: async () => [],
  },
}))

mock.module("../provider/transform", () => ({
  ProviderTransform: {
    schema: (_model: unknown, schema: Record<string, unknown>) => schema,
  },
}))

mock.module("../plugin", () => ({
  Plugin: {
    trigger: async (event: string, meta: Record<string, unknown>, payload: Record<string, unknown>) => {
      state.events.push({ event, meta, payload })
    },
  },
}))

mock.module("@/permission/next", () => ({
  PermissionNext: {
    Ruleset: z.array(z.any()),
    ask: async (input: { permission: string }) => {
      state.asks.push({ permission: input.permission })
    },
    merge: () => [],
  },
}))

mock.module("@/tool/truncation", () => ({
  Truncate: {
    output: async (text: string) => ({
      content: text,
      truncated: false,
    }),
  },
}))

mock.module("../mcp", () => ({
  MCP: {
    connectedTools: async () => {
      state.calls.connected += 1
      return state.connected
    },
    tools: async () => {
      state.calls.tools += 1
      return state.all
    },
  },
}))

const { SessionPrompt } = await import("./prompt")

function makeTool(text: string): McpTool {
  return {
    description: text,
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => ({
      content: [{ type: "text", text }],
      metadata: {},
    }),
  }
}

function makeInput(): Parameters<typeof SessionPrompt.resolveTools>[0] {
  return {
    agent: {
      name: "build",
      permission: [],
    } as unknown as Parameters<typeof SessionPrompt.resolveTools>[0]["agent"],
    model: {
      providerID: "test",
      api: { id: "test" },
    } as Parameters<typeof SessionPrompt.resolveTools>[0]["model"],
    session: {
      id: "session_1",
      permission: [],
    } as unknown as Parameters<typeof SessionPrompt.resolveTools>[0]["session"],
    processor: {
      message: { id: "message_1" },
      partFromToolCall: () => undefined,
    } as unknown as Parameters<typeof SessionPrompt.resolveTools>[0]["processor"],
    bypassAgentCheck: false,
    messages: [],
  }
}

describe("SessionPrompt.resolveTools lazy MCP", () => {
  beforeEach(() => {
    state.cfg = {}
    state.connected = {}
    state.all = {}
    state.calls.connected = 0
    state.calls.tools = 0
    state.events = []
    state.asks = []
  })

  test("lazy_mcp false keeps connected-tools-only behavior", async () => {
    state.cfg = { experimental: { lazy_mcp: false } }
    state.connected = {
      connected_tool: makeTool("connected"),
    }
    state.all = {
      connected_tool: makeTool("connected"),
      mcp_activate_demo: makeTool("gateway"),
    }

    const result = await SessionPrompt.resolveTools(makeInput())

    expect(result.connected_tool).toBeDefined()
    expect(result.mcp_activate_demo).toBeUndefined()
    expect(state.calls.connected).toBe(1)
    expect(state.calls.tools).toBe(0)
  })

  test("lazy_mcp true includes gateway tools with plugin and permission wrapping", async () => {
    state.cfg = { experimental: { lazy_mcp: true } }
    state.all = {
      mcp_activate_demo: makeTool("gateway"),
    }

    const result = await SessionPrompt.resolveTools(makeInput())
    const tool = result.mcp_activate_demo
    expect(tool).toBeDefined()

    if (!tool.execute) throw new Error("missing execute")
    const output = await tool.execute(
      {},
      {
        toolCallId: "call_1",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    )

    expect(output.output).toContain("gateway")
    expect(state.calls.connected).toBe(0)
    expect(state.calls.tools).toBe(1)
    expect(state.asks).toEqual([{ permission: "mcp_activate_demo" }])
    expect(state.events.map((item) => item.event)).toEqual(["tool.execute.before", "tool.execute.after"])
  })
})
