import { mock, describe, it, expect } from "bun:test"

type LocalState = {
  status: Record<string, { status: string }>
  clients: Record<string, unknown>
}

const key = "__mcp_mock_state__"
const root = globalThis as typeof globalThis & { [key: string]: Record<string, unknown> | undefined }
const seed = (root[key] ??= {})
seed.calls ??= {}
const calls = seed.calls as Record<string, number>
calls.connect ??= 0
calls.transport ??= 0
calls.close ??= 0
calls.callTool ??= 0
calls.publish ??= 0
seed.cfg ??= {}
seed.mcpTools ??= []
seed.current ??= undefined
seed.dispose ??= undefined
seed.disposers ??= []
seed.gen ??= 0
seed.delay ??= 0
seed.fail ??= "none"
seed.handler ??= undefined

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    setNotificationHandler() {}
    async listTools() {
      return { tools: [] }
    }
    async close() {}
    async callTool() {
      return { content: [], isError: false }
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr = { on() {} }
  },
}))

mock.module("../config/config", () => ({
  Config: { get: async () => seed.cfg },
}))

mock.module("../project/instance", () => ({
  Instance: {
    directory: "/tmp/opencode-test",
    state: (init: () => Promise<LocalState>, dispose?: (value: LocalState) => Promise<void>) => {
      if (dispose !== undefined) seed.dispose = dispose
      let cur: LocalState | undefined
      let g = -1
      return async () => {
        if (cur && g === (seed.gen as number)) return cur
        cur = await init()
        g = seed.gen as number
        if (dispose !== undefined) seed.current = cur
        return cur
      }
    },
    async disposeAll() {
      if (seed.current && seed.dispose) {
        await (seed.dispose as (value: LocalState) => Promise<void>)(seed.current as LocalState)
      }
      seed.current = undefined
      ;(seed.gen as number)++
    },
  },
}))

mock.module("../skill", () => ({
  Skill: {
    all: async () => [],
    get: async (_name: string) => undefined,
  },
}))

const { SkillSearchTool } = await import("./skill-search")

describe("skill_search tool", () => {
  it("should have id skill_search", () => {
    expect(SkillSearchTool.id).toBe("skill_search")
  })

  it("should have description", async () => {
    const init = await SkillSearchTool.init()
    expect(init.description.toLowerCase()).toContain("search")
    expect(init.description.length).toBeGreaterThan(0)
  })

  it("should accept query parameter", async () => {
    const init = await SkillSearchTool.init()
    const params = init.parameters
    const result = params.safeParse({ query: "playwright" })
    expect(result.success).toBe(true)
  })

  it("should reject missing query parameter", async () => {
    const init = await SkillSearchTool.init()
    const params = init.parameters
    const result = params.safeParse({})
    expect(result.success).toBe(false)
  })
})
