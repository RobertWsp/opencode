import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { isAccountExhausted, COOLDOWN_MAX_WAIT_MS, EXHAUSTION_RETRY_AFTER_MS } from "@/provider/account-pool"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { CONFABULATION_PATTERN } from "./constants"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  async function injectSwitchNotification(
    msg: MessageV2.Assistant,
    sessionID: string,
    pool: NonNullable<Awaited<ReturnType<typeof Provider.getPool>>>,
  ) {
    const stats = pool.stats()
    const states = pool.states()
    const active = states[stats.activeIndex]
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID,
      type: "text",
      text: `⚡ Account switched → ${active.info.label}`,
      ignored: true,
      synthetic: true,
    })
  }

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        let switches = 0
        while (true) {
          const usedAccount = (await Provider.getPool(input.model.providerID))?.stats().activeIndex
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  const reasoningPart = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning" as const,
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  reasoningMap[value.id] = reasoningPart
                  await Session.updatePart(reasoningPart)
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePartDelta({
                      sessionID: part.sessionID,
                      messageID: part.messageID,
                      partID: part.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Provider.trackUsage(input.model.providerID, usage.tokens.total ?? 0)
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (
                    !input.assistantMessage.summary &&
                    (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model }))
                  ) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  await Session.updatePart(currentText)
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePartDelta({
                      sessionID: currentText.sessionID,
                      messageID: currentText.messageID,
                      partID: currentText.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                    // Telemetry for the pruned-output confabulation failure mode.
                    // Patch 1 (pruned tool parts → error-text) is the primary
                    // fix; this check is a passive safety net that flags any
                    // remaining leakage so we can observe regressions without
                    // changing runtime behavior.
                    if (CONFABULATION_PATTERN.test(currentText.text)) {
                      log.warn("assistant text matches confabulation pattern", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                        sample: currentText.text.slice(0, 240),
                      })
                    }
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              needsCompaction = true
              Bus.publish(Session.Event.Error, {
                sessionID: input.sessionID,
                error,
              })
            } else {
              if (MessageV2.APIError.isInstance(error)) {
                // "long context" 429 means the request exceeds the OAuth context limit —
                // treat as context overflow to trigger compaction instead of cooldown
                if (
                  error.data.statusCode === 429 &&
                  typeof error.data.responseBody === "string" &&
                  error.data.responseBody.includes("long context")
                ) {
                  log.info("long context rejection — triggering compaction", {
                    sessionID: input.sessionID,
                  })
                  needsCompaction = true
                  Bus.publish(Session.Event.Error, { sessionID: input.sessionID, error })
                  break
                }
                const pool = await Provider.getPool(input.model.providerID)
                if (pool) {
                  const faulted = usedAccount ?? pool.stats().activeIndex
                  const maxSwitches = Math.max(pool.stats().accountCount * 2, 3)
                  if (error.data.statusCode === 429) {
                    const parsed = error.data.responseHeaders?.["retry-after-ms"]
                      ? Number.parseFloat(error.data.responseHeaders["retry-after-ms"])
                      : error.data.responseHeaders?.["retry-after"]
                        ? Number.parseFloat(error.data.responseHeaders["retry-after"]) * 1000
                        : 60_000
                    const retryAfterMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000

                    const exhausted = isAccountExhausted(retryAfterMs, error.data.responseBody)
                    // Always use cooldown for 429s — even exhausted accounts recover
                    // when the provider's quota resets. pool.cooldown() caps at 10 min.
                    pool.cooldown(faulted, Date.now() + retryAfterMs)
                    await Provider.savePoolNow(input.model.providerID)

                    if (switches < maxSwitches) {
                      await Provider.syncPool(input.model.providerID)

                      if (pool.hasHealthy()) {
                        switches++
                        await Provider.rotateAccount(input.model.providerID)
                        await injectSwitchNotification(input.assistantMessage, input.sessionID, pool)
                        continue
                      }

                      // Re-enable disabled accounts — they may have recovered
                      // from transient auth failures or token refreshes. If they
                      // truly can't authenticate, the 401 handler will re-disable
                      // them. Persist immediately so syncPool() won't revert.
                      let reenabled = false
                      for (const s of pool.states()) {
                        if (s.status === "disabled") {
                          pool.enable(s.info.index)
                          reenabled = true
                        }
                      }
                      if (reenabled) {
                        await Provider.savePoolNow(input.model.providerID)
                        if (pool.hasHealthy()) {
                          switches++
                          await Provider.rotateAccount(input.model.providerID)
                          await injectSwitchNotification(input.assistantMessage, input.sessionID, pool)
                          continue
                        }
                      }

                      let switched = false
                      while (switches < maxSwitches) {
                        const hasCooldown = pool.states().some((s) => s.status === "cooldown")
                        if (!hasCooldown) break

                        const wait = pool.soonestCooldownMs()
                        if (wait !== undefined && wait > 0) {
                          const capped = Math.min(wait, COOLDOWN_MAX_WAIT_MS)
                          switches++
                          SessionStatus.set(input.sessionID, {
                            type: "retry",
                            attempt: switches,
                            message: exhausted
                              ? "Account exhausted, waiting for cooldown"
                              : "All accounts on cooldown, waiting",
                            next: Date.now() + capped,
                          })
                          await SessionRetry.sleep(capped, input.abort).catch(() => {})
                          await Provider.syncPool(input.model.providerID)
                        }

                        if (pool.hasHealthy()) {
                          await Provider.rotateAccount(input.model.providerID)
                          await injectSwitchNotification(input.assistantMessage, input.sessionID, pool)
                          switched = true
                          break
                        }
                      }
                      if (switched) continue
                    }

                    // All switch attempts exhausted or maxSwitches reached —
                    // terminate instead of falling through to generic retry,
                    // which would loop forever on the same 429'd account.
                    log.error("all accounts exhausted", { providerID: input.model.providerID })
                    input.assistantMessage.error = error
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error,
                    })
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  }
                  // HTTP 400 with exhaustion body (e.g. "out of extra usage") —
                  // treat as account exhaustion: cooldown + rotate, same as 429
                  if (
                    error.data.statusCode === 400 &&
                    typeof error.data.responseBody === "string" &&
                    isAccountExhausted(0, error.data.responseBody)
                  ) {
                    pool.cooldown(faulted, Date.now() + EXHAUSTION_RETRY_AFTER_MS)
                    await Provider.savePoolNow(input.model.providerID)

                    if (switches < maxSwitches) {
                      await Provider.syncPool(input.model.providerID)

                      if (pool.hasHealthy()) {
                        switches++
                        await Provider.rotateAccount(input.model.providerID)
                        await injectSwitchNotification(input.assistantMessage, input.sessionID, pool)
                        continue
                      }

                      // Re-enable disabled accounts — they may have recovered
                      let reenabled = false
                      for (const s of pool.states()) {
                        if (s.status === "disabled") {
                          pool.enable(s.info.index)
                          reenabled = true
                        }
                      }
                      if (reenabled) {
                        await Provider.savePoolNow(input.model.providerID)
                        if (pool.hasHealthy()) {
                          switches++
                          await Provider.rotateAccount(input.model.providerID)
                          await injectSwitchNotification(input.assistantMessage, input.sessionID, pool)
                          continue
                        }
                      }
                    }

                    log.error("all accounts exhausted (billing)", { providerID: input.model.providerID })
                    input.assistantMessage.error = error
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error,
                    })
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  }
                  if (error.data.statusCode === 401 || error.data.statusCode === 403) {
                    pool.disable(faulted)
                    await Provider.savePoolNow(input.model.providerID)
                    if (pool.hasHealthy() && switches < maxSwitches) {
                      switches++
                      await Provider.rotateAccount(input.model.providerID)
                      await injectSwitchNotification(input.assistantMessage, input.sessionID, pool)
                      continue
                    }

                    // No active accounts — wait for cooldown accounts to recover
                    // before giving up (mirrors the 429 handler's wait logic).
                    if (switches < maxSwitches) {
                      const wait = pool.soonestCooldownMs()
                      if (wait !== undefined && wait > 0) {
                        const capped = Math.min(wait, COOLDOWN_MAX_WAIT_MS)
                        switches++
                        SessionStatus.set(input.sessionID, {
                          type: "retry",
                          attempt: switches,
                          message: "Account disabled, waiting for another to recover",
                          next: Date.now() + capped,
                        })
                        await SessionRetry.sleep(capped, input.abort).catch(() => {})
                        await Provider.syncPool(input.model.providerID)
                        if (pool.hasHealthy()) {
                          await Provider.rotateAccount(input.model.providerID)
                          await injectSwitchNotification(input.assistantMessage, input.sessionID, pool)
                          continue
                        }
                      }
                    }

                    log.error("all accounts disabled", {
                      providerID: input.model.providerID,
                      statusCode: error.data.statusCode,
                    })
                    input.assistantMessage.error = error
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error,
                    })
                    input.assistantMessage.time.completed = Date.now()
                    await Session.updateMessage(input.assistantMessage)
                    return "stop"
                  }
                }
              }
              const retry = SessionRetry.retryable(error)
              if (retry !== undefined) {
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                SessionStatus.set(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                await SessionRetry.sleep(delay, input.abort).catch(() => {})
                continue
              }
              input.assistantMessage.error = error
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
              SessionStatus.set(input.sessionID, { type: "idle" })
            }
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
