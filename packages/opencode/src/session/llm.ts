import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  /**
   * Try to repair an unknown tool name to a valid registry key.
   *
   * Returns the repaired name + reason, or null when no repair is possible.
   * Pure function — no side effects, only reads keys from `tools`.
   *
   * Strategies, in order:
   *   1. **lowercase**   — the existing fix for providers that up-case.
   *   2. **mcp-prefix-strip** — recover from two observed failure modes:
   *      a) Meridian's passthrough MCP wrapper didn't strip its `mcp__oc__`
   *         prefix on a specific tool_use (seen in the wild with
   *         `mcp__oc__background_output` even though Meridian's
   *         stripMcpPrefix is nominally universal).
   *      b) The model hallucinated an `mcp__<server>__` prefix on a tool
   *         that wasn't actually wrapped (a variant of the confabulation
   *         behavior Patches 1-6 address for text — this covers tool_use).
   *
   *   For mcp-prefix-strip we try the bare tool name first (Meridian
   *   wrapper case) and then `<server>_<tool>` (OpenCode's MCP namespace
   *   convention). Each candidate is also tried lowercase.
   */
  export function repairToolName(
    toolName: string,
    tools: Record<string, unknown>,
  ): { found: string; reason: "lowercase" | "mcp-prefix-strip" } | null {
    // The SDK never invokes repair when the name is already valid, but this
    // function is public + pure so guard against that input anyway.
    if (tools[toolName]) return null

    // Strategy 1: case-insensitive lookup
    const lower = toolName.toLowerCase()
    if (lower !== toolName && tools[lower]) {
      return { found: lower, reason: "lowercase" }
    }

    // Strategy 2: strip mcp__<server>__ prefix
    if (toolName.startsWith("mcp__")) {
      const parts = toolName.split("__")
      // Need at least ["mcp", server, ...toolParts] → length >= 3, and the
      // server segment must be non-empty (so "mcp____foo" doesn't qualify).
      if (parts.length >= 3 && parts[1].length > 0) {
        const server = parts[1]
        const bareTool = parts.slice(2).join("__")
        if (bareTool.length > 0) {
          const candidates = [
            bareTool, // "mcp__oc__background_output" → "background_output"
            `${server}_${bareTool}`, // "mcp__github__get_commit" → "github_get_commit"
            bareTool.toLowerCase(),
            `${server}_${bareTool}`.toLowerCase(),
          ]
          for (const candidate of candidates) {
            if (tools[candidate]) {
              return { found: candidate, reason: "mcp-prefix-strip" }
            }
          }
        }
      }
    }

    return null
  }

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
        // Propagate the caller's abort signal so plugins that block (e.g.
        // Meridian's waitForHealthyProfile — can sleep up to MERIDIAN_WAIT_MAX_MS
        // = 7d) can be interrupted by Ctrl+C. Without this, pressing Ctrl+C
        // during a wait leaves the process blocked until the wait's own
        // timeout, not the user's. Keep both names for plugin-side flexibility.
        signal: input.abort,
        abortSignal: input.abort,
      } as any,
      {
        headers: {},
      },
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const tools = await resolveTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    // Optional payload capture for token-budget analysis.
    // Set OPENCODE_CAPTURE_PAYLOAD=/path/to/dir to dump the pre-stream
    // params snapshot (system/tools/messages). Disabled by default.
    // NB: this runs BEFORE the Meridian/Anthropic fetch interceptors, so it
    // captures what OpenCode produces regardless of routing path.
    const captureDir = process.env.OPENCODE_CAPTURE_PAYLOAD
    if (captureDir) {
      try {
        const fs = await import("fs")
        const path = await import("path")
        fs.mkdirSync(captureDir, { recursive: true })
        const stamp = Date.now()
        const summary = {
          capturedAt: new Date(stamp).toISOString(),
          sessionID: input.sessionID,
          agent: input.agent?.name,
          modelID: input.model.id,
          providerID: input.model.providerID,
          systemMessages: system.length,
          systemChars: system.map((s) => s.length),
          systemTotalChars: system.reduce((a, b) => a + b.length, 0),
          toolCount: Object.keys(tools).length,
          toolNames: Object.keys(tools),
          messageCount: input.messages.length,
          messagesJson: JSON.stringify(input.messages).length,
          maxOutputTokens,
          options: params.options,
        }
        fs.writeFileSync(
          path.join(captureDir, `${stamp}_${input.model.id.replace(/[^a-z0-9]/gi, "_")}.json`),
          JSON.stringify(
            {
              summary,
              system,
              tools: Object.fromEntries(
                Object.entries(tools).map(([k, v]: any) => [
                  k,
                  { description: v.description, inputSchema: v.inputSchema?.jsonSchema ?? v.inputSchema },
                ]),
              ),
              messages: input.messages,
            },
            null,
            2,
          ),
        )
      } catch {
        // best-effort — never break the request on capture failure
      }
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const original = failed.toolCall.toolName
        const repaired = repairToolName(original, tools as Record<string, unknown>)
        if (repaired) {
          l.info("repairing tool call", {
            tool: original,
            repaired: repaired.found,
            reason: repaired.reason,
          })
          return {
            ...failed.toolCall,
            toolName: repaired.found,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: original,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const before = Object.keys(input.tools)
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    const rmUserFalse: string[] = []
    const rmDisabled: string[] = []
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false) {
        rmUserFalse.push(tool)
        delete input.tools[tool]
      } else if (disabled.has(tool)) {
        rmDisabled.push(tool)
        delete input.tools[tool]
      }
    }
    if (process.env.OPENCODE_DEBUG_SUBAGENT_TOOLS === "1") {
      // eslint-disable-next-line no-console
      console.error(
        `[llm.resolveTools] agent=${input.agent.name} before=${before.length} after=${Object.keys(input.tools).length} ` +
          `rmUserFalse=${JSON.stringify(rmUserFalse)} rmDisabled=${JSON.stringify(rmDisabled)} ` +
          `userToolsKeys=${JSON.stringify(input.user.tools ? Object.keys(input.user.tools) : null)} ` +
          `agentPerm=${JSON.stringify(input.agent.permission.map((r) => r.permission + ":" + r.action))}`,
      )
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
