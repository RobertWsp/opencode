import os from "os"
import path from "path"
import { why } from "./commands"
import { detectScope } from "./scope"

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown }
type RpcResponse = {
  jsonrpc: "2.0"
  id?: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

const TOOL_WHY = {
  name: "memory.why",
  description: "Explains why a concept/decision was made by retrieving rationale-annotated memories",
  inputSchema: {
    type: "object",
    properties: { concept: { type: "string" } },
    required: ["concept"],
  },
}

function ok(id: string | number | null | undefined, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function rpcErr(id: string | number | null | undefined, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

async function resolveScope() {
  const vault = process.env["MEMORY_VAULT"] ?? path.join(os.homedir(), ".local", "share", "obsidian-memory")
  return detectScope({ worktree: process.cwd(), vaultPath: vault })
}

async function handle(req: JsonRpc): Promise<RpcResponse | null> {
  if (req.method === "initialize") {
    return ok(req.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "obsidian-memory", version: "1.0.0" },
    })
  }
  if (req.method === "initialized") return null
  if (req.method === "tools/list") return ok(req.id, { tools: [TOOL_WHY] })
  if (req.method === "tools/call") {
    const p = req.params as { name: string; arguments: Record<string, unknown> }
    if (p.name !== "memory.why") return rpcErr(req.id, -32602, `unknown tool: ${p.name}`)
    const concept = p.arguments?.concept
    if (typeof concept !== "string" || !concept.trim()) {
      return ok(req.id, {
        content: [{ type: "text", text: JSON.stringify({ error: "concept is required" }) }],
        isError: true,
      })
    }
    const scope = await resolveScope()
    if (!scope) {
      return ok(req.id, {
        content: [{ type: "text", text: JSON.stringify({ error: "vault not configured or git repo not detected" }) }],
        isError: true,
      })
    }
    const entries = await why(concept.trim(), scope)
    return ok(req.id, { content: [{ type: "text", text: JSON.stringify(entries) }] })
  }
  return rpcErr(req.id, -32601, "Method not found")
}

async function main() {
  process.stdin.setEncoding("utf8")
  let buf = ""
  process.stdin.on("data", async (chunk: string) => {
    buf += chunk
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const req = JSON.parse(trimmed) as JsonRpc
        const res = await handle(req)
        if (res !== null) process.stdout.write(JSON.stringify(res) + "\n")
      } catch {}
    }
  })
}

main().catch(console.error)
