import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { Tiering } from "../agent/tiering"
import { MCP } from "../mcp"

const active = new Map<string, number>()
const failures = new Map<string, number>()

function increment(session: string) {
  active.set(session, (active.get(session) ?? 0) + 1)
}

function decrement(session: string) {
  const n = (active.get(session) ?? 1) - 1
  if (n <= 0) {
    // Delete and return — do NOT re-set to 0, that leaks entries in
    // the active map and breaks maxParallel accounting across long
    // sessions that repeatedly spawn+finish subagents.
    active.delete(session)
    return
  }
  active.set(session, n)
}

function recordFailure(session: string) {
  failures.set(session, (failures.get(session) ?? 0) + 1)
}

function clearFailures(session: string) {
  failures.delete(session)
}

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  tier: z
    .enum(["quality", "balanced", "budget", "adaptive", "inherit"])
    .describe(
      "Optional tier override (quality=Opus, balanced=Sonnet, budget=Haiku). When set, the subagent uses this tier's model regardless of the agent's own tier. Used by the model router to dispatch a tier-specific spawn.",
    )
    .optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      if (agent.maxParallel) {
        const running = active.get(ctx.sessionID) ?? 0
        if (running >= agent.maxParallel)
          throw new Error(`Max parallel tasks reached (${agent.maxParallel}). Wait for running tasks to complete.`)
      }

      // Explicit task_id resume is a user-initiated retry — reset the
      // consecutive-failure counter so we don't block legitimate retries
      // of a previously-failed task. The 3-strikes guard is only meant
      // to stop runaway automatic loops, not deliberate resumes.
      if (params.task_id) {
        clearFailures(ctx.sessionID)
      }

      const consecutive = failures.get(ctx.sessionID) ?? 0
      if (consecutive >= 3)
        throw new Error(`3 consecutive task failures detected. Review errors before retrying.`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(params.task_id).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      // Resolution order:
      //   1. Explicit tier override on the call (router-driven spawn)
      //   2. Agent.model (if the agent pins a specific model)
      //   3. Agent.tier (the agent's declared tier)
      //   4. Inherit parent's modelID
      //
      // Tiering.resolve() returns "" for adaptive/inherit (no DEFAULTS
      // entries). Resolve those abstract tiers to concrete ones first,
      // then ask Tiering.resolve for the modelID mapping.
      function resolveConcreteTier(t: Tiering.Tier | undefined): Tiering.Tier | undefined {
        if (!t) return undefined
        if (t === "inherit") return undefined // let the ?? chain fall through to parent
        if (t === "adaptive") {
          // We don't have rich history here — approximate via the parent
          // assistant message's token usage. Cheap; the classifier
          // elsewhere does the real work.
          const assistantInfo = msg.info as MessageV2.Assistant
          const parentTokens = assistantInfo.tokens?.input ?? 0
          return Tiering.adaptive({ tokens: parentTokens, tools: 0, files: 0 })
        }
        return t
      }
      const tierOverrideConcrete = resolveConcreteTier(params.tier)
      const agentTierConcrete = resolveConcreteTier(agent.tier)
      const model = (tierOverrideConcrete ? Tiering.resolve(tierOverrideConcrete, msg.info.providerID) : undefined)
        ?? agent.model
        ?? (agentTierConcrete ? Tiering.resolve(agentTierConcrete, msg.info.providerID) : undefined)
        ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      const messageID = Identifier.ascending("message")

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const deviation = [
        "",
        "<deviation_rules>",
        "While executing, apply these rules automatically:",
        "- Bugs (broken behavior, errors, incorrect output): Fix inline, no permission needed",
        "- Missing critical functionality (auth, validation, error handling): Add inline, no permission needed",
        "- Blocking issues (missing deps, wrong types, broken imports): Fix inline, no permission needed",
        "- Architectural changes (new DB table, schema change, switching libs): STOP and report back",
        "",
        "Priority: Architectural → STOP. All others → fix automatically.",
        "</deviation_rules>",
      ].join("\n")
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt + deviation)

      increment(ctx.sessionID)
      using _track = defer(() => decrement(ctx.sessionID))
      let result
      // Subagents default-off for todowrite/todoread (parent owns the plan
      // list). All OTHER registry tools — including `skill`, `skill_search`
      // and every MCP (gateway + connected) — are left unset here so they
      // land in the subagent's tool schema by default. The per-agent
      // `permission` map (e.g. explore deny write/edit) still filters them
      // at invocation time via `PermissionNext.disabled`, so read-only
      // agents stay read-only; they just gain access to lookup/search
      // tools they were silently missing before.
      //
      // MCPs are enumerated explicitly with `true` so they survive the
      // user.tools filter in llm.ts resolveTools (which deletes anything
      // with undefined/false). This is lazy-mcp-friendly: the entries
      // here are `mcp_activate_*` gateway tools (4 bytes of schema each)
      // when lazy_mcp is on, NOT full MCP schemas. Connected tools come
      // from connectedTools() already — same cost as the parent.
      const subagentTools: Record<string, boolean> = {
        todowrite: false,
        todoread: false,
        ...(hasTaskPermission ? {} : { task: false }),
        ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        // Explicit allows for skill system and MCP registry. Without these
        // the server's per-call user.tools filter strips them out even
        // though they're registered. `false` would block; `true` keeps.
        skill: true,
        skill_search: true,
      }
      try {
        const allMcpTools = config.experimental?.lazy_mcp
          ? await MCP.tools().catch(() => ({}))
          : await MCP.connectedTools().catch(() => ({}))
        for (const toolID of Object.keys(allMcpTools)) {
          if (!(toolID in subagentTools)) subagentTools[toolID] = true
        }
      } catch {
        // MCP enumeration is best-effort — on failure the subagent still
        // runs with core tools.
      }

      try {
        result = await SessionPrompt.prompt({
          messageID,
          sessionID: session.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: agent.name,
          tools: subagentTools,
          parts: promptParts,
        })
      } catch (err) {
        // Record the failure so the 3-consecutive-failure guard at the
        // top of execute() actually protects against runaway retries.
        // Without this, recordFailure() was dead code and the guard
        // could never fire.
        recordFailure(ctx.sessionID)
        throw err
      }

      const subagentError = result.info.role === "assistant" ? result.info.error : undefined
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      if (subagentError && !text.trim()) {
        recordFailure(ctx.sessionID)
        const errMsg = JSON.stringify(subagentError)
        throw new Error(
          `Subagent ${agent.name} failed before producing output: ${errMsg.slice(0, 200)}. Parent should retry or delegate to a different agent.`,
        )
      }

      clearFailures(ctx.sessionID)

      const statusLine = subagentError
        ? `<task_status>PARTIAL — subagent errored after partial output (${JSON.stringify(subagentError).slice(0, 120)}). Use output below with caution; consider retrying with task_id=${session.id}.</task_status>`
        : "<task_status>COMPLETED — results above are final. Process them now. Do not wait for further notifications.</task_status>"

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
        "",
        statusLine,
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
        output,
      }
    },
  }
})
