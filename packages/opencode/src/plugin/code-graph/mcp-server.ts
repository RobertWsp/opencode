#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const ROOT = process.env.CODE_GRAPH_ROOT ?? process.cwd()

const server = new Server({ name: "code-graph", version: "0.1.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${req.params.name}` }) }],
  isError: true,
}))

const transport = new StdioServerTransport()
await server.connect(transport)
void ROOT
