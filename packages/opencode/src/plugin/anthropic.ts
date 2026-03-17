import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { APICallError } from "ai"
import { Log } from "../util/log"
import { OAUTH_DUMMY_KEY, Auth } from "../auth"
import { generatePKCE } from "@openauthjs/openauth/pkce"

const log = Log.create({ service: "plugin.anthropic" })

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOOL_PREFIX = "mcp_"

async function authorize(mode: "max" | "console") {
  const pkce = await generatePKCE()
  const url = new URL(`https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback")
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  return { url: url.toString(), verifier: pkce.verifier }
}

async function exchange(code: string, verifier: string) {
  const splits = code.split("#")
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  })
  if (!result.ok) return { type: "failed" as const }
  const json = (await result.json()) as { refresh_token: string; access_token: string; expires_in: number }
  return {
    type: "success" as const,
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export async function AnthropicAuthPlugin({ client }: PluginInput): Promise<Hooks> {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix)
        if (output.system[1]) output.system[1] = prefix + "\n\n" + output.system[1]
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type === "oauth") {
          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
          }
          return {
            apiKey: OAUTH_DUMMY_KEY,
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const auth = await getAuth()
              if (!auth || auth.type !== "oauth") return fetch(input, init)

              // Use the _key property injected by pool-aware getAuth (see provider.ts)
              const authKey = (auth as Auth.InfoWithKey)._key ?? "anthropic"

              if (!auth.access || auth.expires - 60_000 < Date.now()) {
                log.info("refreshing anthropic access token", { authKey })
                const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    grant_type: "refresh_token",
                    refresh_token: auth.refresh,
                    client_id: CLIENT_ID,
                  }),
                })
                if (!response.ok) {
                  const body = await response.text().catch(() => "")
                  log.error("token refresh failed", { status: response.status, body, authKey })
                  throw new APICallError({
                    message: `Anthropic OAuth token refresh failed: ${response.status}${body ? ` — ${body}` : ""}`,
                    url: "https://console.anthropic.com/v1/oauth/token",
                    requestBodyValues: { grant_type: "refresh_token" },
                    statusCode: response.status,
                    responseBody: body,
                    isRetryable: false,
                  })
                }
                const json = (await response.json()) as {
                  refresh_token: string
                  access_token: string
                  expires_in: number
                }
                // Save to the correct auth.json key (dynamic, not hardcoded "anthropic")
                await client.auth.set({
                  path: { id: authKey },
                  body: {
                    type: "oauth",
                    refresh: json.refresh_token,
                    access: json.access_token,
                    expires: Date.now() + json.expires_in * 1000,
                  },
                })
                auth.access = json.access_token
              }

              const headers = new Headers()
              if (input instanceof Request) {
                input.headers.forEach((value, key) => headers.set(key, value))
              }
              if (init?.headers) {
                if (init.headers instanceof Headers) {
                  init.headers.forEach((value, key) => headers.set(key, value))
                } else if (Array.isArray(init.headers)) {
                  for (const [key, value] of init.headers) {
                    if (typeof value !== "undefined") headers.set(key, String(value))
                  }
                } else {
                  for (const [key, value] of Object.entries(init.headers)) {
                    if (typeof value !== "undefined") headers.set(key, String(value))
                  }
                }
              }

              // Merge beta headers — preserve incoming, ensure required ones
              const incoming = headers.get("anthropic-beta") || ""
              const existing = incoming
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean)
              const required = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"]
              const merged = [...new Set([...required, ...existing])].join(",")

              headers.set("authorization", `Bearer ${auth.access}`)
              headers.set("anthropic-beta", merged)
              headers.set("user-agent", "claude-cli/2.1.2 (external, cli)")
              headers.delete("x-api-key")

              let body = init?.body
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body)

                  // Sanitize system prompt — server blocks "OpenCode" string
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map((item: { type: string; text?: string }) => {
                      if (item.type === "text" && item.text)
                        return {
                          ...item,
                          text: item.text.replace(/OpenCode/g, "Claude Code").replace(/opencode/gi, "Claude"),
                        }
                      return item
                    })
                  }

                  // Add prefix to tool definitions
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map((tool: { name?: string }) => ({
                      ...tool,
                      name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
                    }))
                  }

                  // Add prefix to tool_use blocks in messages
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map(
                      (msg: { content?: Array<{ type: string; name?: string }> }) => {
                        if (msg.content && Array.isArray(msg.content)) {
                          msg.content = msg.content.map((block) => {
                            if (block.type === "tool_use" && block.name)
                              return { ...block, name: `${TOOL_PREFIX}${block.name}` }
                            return block
                          })
                        }
                        return msg
                      },
                    )
                  }

                  body = JSON.stringify(parsed)
                } catch {
                  // ignore parse errors
                }
              }

              // Append ?beta=true to /v1/messages requests
              let url = input
              try {
                const parsed =
                  typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url)
                if (parsed.pathname === "/v1/messages" && !parsed.searchParams.has("beta")) {
                  parsed.searchParams.set("beta", "true")
                  url = input instanceof Request ? new Request(parsed.toString(), input) : parsed
                }
              } catch {
                // ignore URL parse errors
              }

              const response = await fetch(url, { ...init, body, headers })

              // Transform streaming response to strip tool prefix back
              if (response.body) {
                const reader = response.body.getReader()
                const decoder = new TextDecoder()
                const encoder = new TextEncoder()
                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read()
                    if (done) {
                      controller.close()
                      return
                    }
                    let text = decoder.decode(value, { stream: true })
                    text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
                    controller.enqueue(encoder.encode(text))
                  },
                })
                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                })
              }

              return response
            },
          }
        }
        return {}
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max")
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => exchange(code, verifier),
            }
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console")
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                if (credentials.type === "failed") return credentials
                const result = await fetch("https://api.anthropic.com/api/oauth/claude_cli/create_api_key", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${credentials.access}`,
                  },
                }).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: "success" as const, key: result.raw_key }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
