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
import { CONFABULATION_PATTERN, CONFABULATION_QUARANTINE_NOTICE } from "./constants"
import { RouterNotifications } from "./router-notifications"
import { defer } from "@/util/defer"

/**
 * Parse a Claude Code subscription-cap reset time out of the human-readable
 * error message ("You've hit your limit · resets 5pm (America/Sao_Paulo)").
 * Returns the reset timestamp in ms, or null if the shape doesn't match.
 * Inline implementation (mirrors oh-my-opencode/parseResetAt) so we don't
 * need a cross-package dependency.
 */
function parseClaudeCodeResetAt(msg: string, now = Date.now()): number | null {
  const m = msg.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i)
  if (!m) return null
  const [, hh, mm, ampm, tz] = m
  let hour = parseInt(hh, 10)
  const minute = mm ? parseInt(mm, 10) : 0
  if (ampm.toLowerCase() === "pm" && hour < 12) hour += 12
  if (ampm.toLowerCase() === "am" && hour === 12) hour = 0
  const target = tz ? tz.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone
  const ref = new Date(now)
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: target,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
    const parts = Object.fromEntries(fmt.formatToParts(ref).map((p) => [p.type, p.value]))
    const year = Number(parts.year)
    const month = Number(parts.month)
    const day = Number(parts.day)
    const asIfUtc = Date.UTC(year, month - 1, day, hour, minute)
    const tzClockAsUtc = Date.UTC(year, month - 1, day, Number(parts.hour), Number(parts.minute))
    const offset = tzClockAsUtc - ref.getTime()
    let resetAt = asIfUtc - offset
    if (resetAt <= now) resetAt += 24 * 60 * 60 * 1000
    return resetAt
  } catch {
    return null
  }
}

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

  /**
   * Drain the router notification queue for this session and inject each
   * pending notification as a synthetic text part on the assistant message.
   * Same pattern as injectSwitchNotification, but the source is the
   * oh-my-opencode model-router plugin (via RouterNotifications globalThis
   * queue).
   */
  async function drainRouterNotifications(msg: MessageV2.Assistant, sessionID: string) {
    const pending = RouterNotifications.consume(sessionID)
    for (const entry of pending) {
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID,
        type: "text",
        text: entry.text,
        ignored: true,
        synthetic: true,
      })
    }
  }

  // Queue of pending Meridian wait notifications keyed by sessionID.
  // Populated by the __meridianNotifyWait global that the Meridian plugin
  // invokes when it enters an extended wait (>30s). Drained at the start
  // of each process() iteration so the user sees "waiting for reset in 3h"
  // instead of a silent hang.
  const meridianWaitQueue = new Map<string, string[]>()

  // Register once on module load so the Meridian plugin can call us.
  ;(() => {
    const reg = globalThis as {
      __meridianNotifyWait?: (info: {
        sessionID: string
        reason: string
        profile: string
        resetAt: number
        waitHuman: string
      }) => void
    }
    if (typeof reg.__meridianNotifyWait === "function") return
    reg.__meridianNotifyWait = (info) => {
      try {
        const icon =
          info.reason === "rate_limit"
            ? "⏳"
            : info.reason === "weekly_limit"
              ? "📅"
              : info.reason === "auth_expired"
                ? "🔑"
                : "⏱️"
        const text = `${icon} Aguardando reset do Meridian (${info.reason}) — próximo disponível em ${info.waitHuman}. A sessão retomará automaticamente.`
        const list = meridianWaitQueue.get(info.sessionID) ?? []
        list.push(text)
        meridianWaitQueue.set(info.sessionID, list)
      } catch {}
    }
  })()

  async function drainMeridianWaitNotifications(msg: MessageV2.Assistant, sessionID: string) {
    const pending = meridianWaitQueue.get(sessionID)
    if (!pending || pending.length === 0) return
    meridianWaitQueue.delete(sessionID)
    for (const text of pending) {
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
        ignored: true,
        synthetic: true,
      })
    }
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
        // Drain any pending router notifications so they appear in the
        // conversation history before the assistant's reply — same UX as
        // account switch notifications.
        await drainRouterNotifications(input.assistantMessage, input.sessionID)
        await drainMeridianWaitNotifications(input.assistantMessage, input.sessionID)
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        let switches = 0
        while (true) {
          // Drain Meridian wait notifications that may have been enqueued
          // between iterations (e.g. after a 429-triggered wait resolved).
          await drainMeridianWaitNotifications(input.assistantMessage, input.sessionID)
          const usedAccount = (await Provider.getPool(input.model.providerID))?.stats().activeIndex
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            // Flag set in text-end when we detect that the ONLY content of
            // the assistant response is a Claude Code subprocess error like
            // "You've hit your limit". Meridian wraps that as a normal HTTP
            // 200 response so it never triggers the APIError path — we have
            // to sniff the body and synthesize a 429 after the stream ends.
            let meridianLimitHitText: string | undefined
            let otherContentEmitted = false
            const stream = await LLM.stream(streamInput)

            const idleTimeoutMs = (await Config.get()).experimental?.stream_idle_timeout_ms ?? 300_000
            let watchdogTimer: ReturnType<typeof setTimeout> | undefined
            let watchdogTripped = false
            const watchdog = new AbortController()
            // Count of tool calls whose execution is currently in flight.
            // The stream legitimately goes quiet between `tool-call` (model
            // finished emitting the call) and the corresponding `tool-result`
            // (tool finished executing locally). A bash script or MCP call
            // can easily take >90s; rearming the watchdog on those events is
            // correct, but we must also NOT let the timer fire in the quiet
            // interval. We disarm while any tool is executing and rearm only
            // when the counter returns to zero.
            let toolsInFlight = 0
            // Count of active reasoning blocks. Opus 4.7 with extended thinking
            // (especially in planner agents like Prometheus) can stay in a
            // single reasoning block for minutes. Providers that buffer SSE
            // through a subprocess (Meridian → `claude --thinking adaptive`)
            // can produce gaps between `reasoning-delta` events that exceed
            // the idle timeout even when the model is actively thinking.
            // Disarm the watchdog between `reasoning-start` and `reasoning-end`
            // — same pattern as toolsInFlight. Deltas still rearm while thinking
            // is active so a truly dead stream is still caught on the next
            // non-thinking event.
            let thinkingInFlight = 0
            const armWatchdog = () => {
              if (watchdogTimer) clearTimeout(watchdogTimer)
              if (toolsInFlight > 0 || thinkingInFlight > 0) {
                // Tool executing locally or reasoning block open — stream
                // idle is expected. Do not arm a fresh timer. The next
                // tool-result / reasoning-end / text event will rearm.
                watchdogTimer = undefined
                return
              }
              watchdogTimer = setTimeout(() => {
                watchdogTripped = true
                watchdog.abort()
              }, idleTimeoutMs)
            }
            const disarmWatchdog = () => {
              if (watchdogTimer) {
                clearTimeout(watchdogTimer)
                watchdogTimer = undefined
              }
            }
            armWatchdog()
            const onAbort = () => watchdog.abort()
            input.abort.addEventListener("abort", onAbort, { once: true })
            using _stopWatchdog = defer(() => {
              if (watchdogTimer) clearTimeout(watchdogTimer)
              input.abort.removeEventListener("abort", onAbort)
            })

            for await (const value of stream.fullStream) {
              if (watchdogTripped) {
                throw new MessageV2.APIError({
                  message: `LLM stream idle for ${idleTimeoutMs / 1000}s — aborting and retrying`,
                  statusCode: 429,
                  responseHeaders: {},
                  responseBody: "stream_idle_timeout",
                  isRetryable: true,
                })
              }
              // Track tool + reasoning lifecycle BEFORE rearming so the arm
              // logic sees the current in-flight counts. tool-call → tool is
              // about to run locally (disarm). tool-result / tool-error → tool
              // done (maybe rearm if nothing else pending). reasoning-start →
              // model entered a thinking block; provider may be silent for
              // minutes (disarm). reasoning-end → thinking block closed
              // (maybe rearm if nothing else pending).
              if (value.type === "tool-call") {
                toolsInFlight++
                disarmWatchdog()
              } else if (value.type === "tool-result" || value.type === "tool-error") {
                toolsInFlight = Math.max(0, toolsInFlight - 1)
                armWatchdog()
              } else if (value.type === "reasoning-start") {
                thinkingInFlight++
                disarmWatchdog()
              } else if (value.type === "reasoning-end") {
                thinkingInFlight = Math.max(0, thinkingInFlight - 1)
                armWatchdog()
              } else {
                armWatchdog()
              }
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
                    // Meridian subprocess errors can arrive inside a reasoning
                    // block too (opus-4-7 with thinking enabled). Same patterns
                    // as text-delta; set the shared flag so the synth-429 path
                    // at stream end triggers a reassign+retry. Clear the
                    // reasoning part so the UI doesn't render the error.
                    if (
                      !meridianLimitHitText &&
                      (/^\s*(?:claude code returned|you['']?ve hit|your organization does not have|please login again|custom betas are only)/i.test(
                        part.text,
                      ) ||
                        /Claude Code returned an error result/i.test(part.text) ||
                        /organization\s+does\s+not\s+have\s+access/i.test(part.text) ||
                        /contact\s+your\s+administrator/i.test(part.text))
                    ) {
                      meridianLimitHitText = part.text
                      part.text = ""
                      await Session.updatePart({
                        ...part,
                        text: "",
                        time: { start: part.time?.start ?? Date.now() },
                      })
                    }
                    if (!meridianLimitHitText) {
                      await Session.updatePartDelta({
                        sessionID: part.sessionID,
                        messageID: part.messageID,
                        partID: part.id,
                        field: "text",
                        delta: value.text,
                      })
                    }
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()
                    // Mirror text-end detection: if reasoning block turned out
                    // to be a wrapped subprocess error, suppress the part and
                    // flag so the stream end synth-429 path fires.
                    if (
                      !meridianLimitHitText &&
                      (/Claude Code returned an error result/i.test(part.text) ||
                        /You['']?ve hit your limit.*resets?\s+\d/i.test(part.text) ||
                        /organization\s+does\s+not\s+have\s+access/i.test(part.text) ||
                        /contact\s+your\s+administrator/i.test(part.text))
                    ) {
                      meridianLimitHitText = part.text
                    }
                    if (meridianLimitHitText) {
                      part.text = ""
                      await Session.updatePart({
                        ...part,
                        text: "",
                        time: { start: part.time?.start ?? Date.now(), end: Date.now() },
                      })
                      delete reasoningMap[value.id]
                      break
                    }

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
                  otherContentEmitted = true
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
                case "error": {
                  // Meridian wraps Claude Code CLI subprocess errors in SSE
                  // `event: error` frames with body:
                  //   {type:"error", error:{type:"api_error", message:"..."}}
                  // Note there is NO `error.code`, so ProviderError.parseStreamError
                  // returns undefined → MessageV2.fromError falls through to
                  // NamedError.Unknown, which the catch-block rotation logic
                  // DOES NOT handle (it only runs for APIError). Detect the
                  // Meridian patterns here and synthesize a 429 APIError so
                  // the catch block runs the reassign+retry path.
                  const rawErr = value.error as any
                  const errText =
                    typeof rawErr === "string"
                      ? rawErr
                      : typeof rawErr?.error?.message === "string"
                        ? rawErr.error.message
                        : typeof rawErr?.message === "string"
                          ? rawErr.message
                          : JSON.stringify(rawErr)
                  const isMeridianSubprocessError =
                    /Claude Code returned an error result/i.test(errText) ||
                    /organization\s+does\s+not\s+have\s+access/i.test(errText) ||
                    /you['']?ve hit your limit/i.test(errText) ||
                    /contact\s+your\s+administrator/i.test(errText) ||
                    /no\s+active\s+(?:claude\s+)?subscription/i.test(errText) ||
                    /subscription\s+required/i.test(errText) ||
                    /please\s+login\s+again/i.test(errText)
                  if (isMeridianSubprocessError) {
                    meridianLimitHitText = errText
                    throw new MessageV2.APIError({
                      message: errText,
                      statusCode: 429,
                      responseHeaders: {},
                      responseBody: errText,
                      isRetryable: true,
                    })
                  }
                  throw value.error
                }

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
                    // Early detection of Meridian subprocess errors. Covers
                    // rate-limit ("You've hit your limit"), no-subscription
                    // ("organization does not have access"), auth errors, and
                    // subprocess-wrapped errors ("Claude Code returned an
                    // error result..."). Check the accumulated text with
                    // ^-anchored patterns (cheap) AND a few mid-text markers
                    // (Meridian sometimes appends stderr before the delta is
                    // flushed, pushing total past any reasonable prefix-only
                    // guard). No length gate — the regex is O(1) on mismatch
                    // because every alternation is anchored.
                    if (
                      !meridianLimitHitText &&
                      (/^\s*(?:claude code returned|you['']?ve hit|your organization does not have|please login again|custom betas are only)/i.test(
                        currentText.text,
                      ) ||
                        /Claude Code returned an error result/i.test(currentText.text) ||
                        /organization\s+does\s+not\s+have\s+access/i.test(currentText.text) ||
                        /contact\s+your\s+administrator/i.test(currentText.text))
                    ) {
                      meridianLimitHitText = currentText.text
                      currentText.text = ""
                      await Session.updatePart({
                        ...currentText,
                        text: "",
                        time: { start: currentText.time?.start ?? Date.now() },
                      })
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    // Gate the delta send on detection AFTER the check above,
                    // so a match on the current accumulated buffer suppresses
                    // THIS delta too (not just subsequent ones).
                    if (!meridianLimitHitText) {
                      await Session.updatePartDelta({
                        sessionID: currentText.sessionID,
                        messageID: currentText.messageID,
                        partID: currentText.id,
                        field: "text",
                        delta: value.text,
                      })
                    }
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    // Detect Meridian wrapping a Claude Code subprocess
                    // error as if it were a normal assistant response.
                    if (
                      !meridianLimitHitText &&
                      (/Claude Code returned an error result/i.test(currentText.text) ||
                        /You['']?ve hit your limit.*resets?\s+\d/i.test(currentText.text) ||
                        /organization\s+does\s+not\s+have\s+access/i.test(currentText.text) ||
                        /contact\s+your\s+administrator/i.test(currentText.text))
                    ) {
                      meridianLimitHitText = currentText.text
                    }
                    // If flagged as subprocess-limit text, don't persist
                    // it to the session — the retry below will surface a
                    // clean status message instead.
                    if (meridianLimitHitText) {
                      currentText.text = ""
                      await Session.updatePart({
                        ...currentText,
                        text: "",
                        time: { start: currentText.time?.start ?? Date.now(), end: Date.now() },
                      })
                      currentText = undefined
                      break
                    }
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
                    // Patch 6: active rewriting. If the model emitted text that
                    // imitates tool-call syntax (e.g. "[Tool Use: bash(...)]"
                    // or "H: [Tool Result for toolu_...]"), replace the stored
                    // content with a quarantine notice before persisting to
                    // the DB. Patch 4 used to only log; that was insufficient
                    // because the confabulated text still entered the session
                    // history and compounded on later turns. By rewriting
                    // here, the DB row never receives fabricated examples —
                    // neither this turn's model call context (already streamed)
                    // nor any future turn's history will include it.
                    if (CONFABULATION_PATTERN.test(currentText.text)) {
                      log.warn("assistant text matches confabulation pattern; replacing with quarantine notice", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                        sample: currentText.text.slice(0, 240),
                      })
                      currentText.text = CONFABULATION_QUARANTINE_NOTICE
                    }
                    await Session.updatePart(currentText)
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

            // Stream finished without an APIError, but Meridian wrapped a
            // Claude Code CLI subprocess error as a normal text response
            // ("You've hit your limit · resets 5pm"). Promote it to a
            // synthesized 429 so the rotation code below kicks in and
            // rotates to another account instead of showing the error.
            if (meridianLimitHitText && !otherContentEmitted) {
              log.warn("meridian subprocess limit hit detected in text response; synthesizing 429", {
                sessionID: input.sessionID,
                textSample: meridianLimitHitText.slice(0, 200),
              })
              throw new MessageV2.APIError({
                message: meridianLimitHitText,
                statusCode: 429,
                responseHeaders: {},
                responseBody: meridianLimitHitText,
                isRetryable: true,
              })
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
                // Claude Code CLI subprocess errors ("You've hit your limit ·
                // resets 5pm") come through Meridian with arbitrary status
                // codes (often 500) because the subprocess exited non-zero.
                // Normalize them to the 429-rotate path so the pool cools
                // down the current account and rotates.
                const bodyText =
                  typeof error.data.responseBody === "string" ? error.data.responseBody : ""
                const rawMsg = (error as { message?: string }).message ?? ""
                const claudeCodeLimitHit =
                  /hit\s+your\s+limit/i.test(bodyText) ||
                  /hit\s+your\s+limit/i.test(rawMsg) ||
                  /you['']?ve\s+hit/i.test(bodyText) ||
                  /you['']?ve\s+hit/i.test(rawMsg)
                // Broader: any Claude Code subprocess error that Meridian wrapped
                // (no_subscription, auth_expired, custom-beta warning, etc.) —
                // classifier in the Meridian plugin already cools the profile
                // correctly; we just need to trigger the rotate+retry path.
                const claudeCodeSubprocessError =
                  /Claude Code returned an error result/i.test(bodyText) ||
                  /Claude Code returned an error result/i.test(rawMsg) ||
                  /organization\s+does\s+not\s+have\s+access/i.test(bodyText) ||
                  /organization\s+does\s+not\s+have\s+access/i.test(rawMsg) ||
                  /contact\s+your\s+administrator/i.test(bodyText) ||
                  /contact\s+your\s+administrator/i.test(rawMsg) ||
                  /no\s+active\s+(?:claude\s+)?subscription/i.test(bodyText) ||
                  /subscription\s+required/i.test(bodyText)
                const normalizedStatus =
                  error.data.statusCode === 429 || claudeCodeLimitHit || claudeCodeSubprocessError
                    ? 429
                    : error.data.statusCode
                if (pool) {
                  const faulted = usedAccount ?? pool.stats().activeIndex
                  const maxSwitches = Math.max(pool.stats().accountCount * 2, 3)
                  // Detect Meridian routing: process.env.ANTHROPIC_BASE_URL
                  // is set by the opencode wrapper when routing through the
                  // Meridian proxy. When active, the pool's own rotation is
                  // ineffective — every "account" in the opencode pool hits
                  // the SAME subprocess backed by one Meridian profile. The
                  // right rotation is at the Meridian profile level via
                  // __meridianReassign. So: single-shot reassign + cooldown
                  // the current pool slot for retryAfterMs, and skip the
                  // cascading pool.next() dance that was producing the
                  // "Account switched → #1 → #2 → #3" chain you saw.
                  const meridianActive =
                    (process.env.ANTHROPIC_BASE_URL ?? "").includes("127.0.0.1:3456") ||
                    typeof (globalThis as { __meridianReassign?: unknown }).__meridianReassign ===
                      "function"
                  if (normalizedStatus === 429) {
                    const parsed = error.data.responseHeaders?.["retry-after-ms"]
                      ? Number.parseFloat(error.data.responseHeaders["retry-after-ms"])
                      : error.data.responseHeaders?.["retry-after"]
                        ? Number.parseFloat(error.data.responseHeaders["retry-after"]) * 1000
                        : 60_000
                    let retryAfterMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000

                    // For Claude Code subscription-cap errors, extract a real
                    // reset time from the message text and use that instead of
                    // the fallback 60s — this surfaces "resets in 4h" to the UI.
                    if (claudeCodeLimitHit) {
                      const combined = `${rawMsg} ${bodyText}`
                      const resetAt = parseClaudeCodeResetAt(combined)
                      if (resetAt && resetAt > Date.now()) {
                        retryAfterMs = resetAt - Date.now()
                        const kind = /weekly/i.test(combined) ? "weekly" : "5h"
                        pool.markSessionLimit(faulted, kind, resetAt)
                      }
                    }

                    // Meridian path: forward to the profile rotator and let
                    // it wait/retry. No pool rotation (would just produce
                    // "Account switched → #N" spam without actually going
                    // to a different profile).
                    if (meridianActive) {
                      // Returned profile from reassign (null = all in cooldown,
                      // wait in chat.headers will resolve). Track successful
                      // switches separately from attempts so an all-cooldown
                      // loop doesn't consume the switch budget — the plugin's
                      // waitForHealthyProfile is the real backstop.
                      let reassignedTo: string | null = null
                      try {
                        const reg = globalThis as {
                          __meridianReassign?: (
                            sid: string,
                            reason?: string,
                            untilOverride?: number,
                          ) => string | null
                        }
                        const combined = `${rawMsg} ${bodyText}`
                        const noSubscription =
                          /organization\s+does\s+not\s+have\s+access/i.test(combined) ||
                          /no\s+active\s+(?:claude\s+)?subscription/i.test(combined) ||
                          /subscription\s+required/i.test(combined) ||
                          /contact\s+your\s+administrator/i.test(combined)
                        const reason = noSubscription
                          ? "no_subscription"
                          : claudeCodeLimitHit
                            ? /weekly/i.test(combined)
                              ? "weekly_limit"
                              : "rate_limit"
                            : "rate_limit"
                        const realResetAt = claudeCodeLimitHit
                          ? parseClaudeCodeResetAt(combined)
                          : null
                        reassignedTo =
                          reg.__meridianReassign?.(
                            input.sessionID,
                            reason,
                            realResetAt ?? undefined,
                          ) ?? null
                        log.info("meridian reassign on 429", {
                          sessionID: input.sessionID,
                          reason,
                          newProfile: reassignedTo ?? "(none — wait will resolve)",
                          resetAt: realResetAt
                            ? new Date(realResetAt).toISOString()
                            : "(default cooldown)",
                        })
                      } catch (err) {
                        log.warn("meridian reassign threw", { error: String(err) })
                      }
                      // On Meridian path, let the plugin's waitForHealthyProfile
                      // (invoked by chat.headers on the next LLM.stream) act as
                      // the real backstop. Only count a "switch" when we actually
                      // rotated to a different profile; otherwise the wait is
                      // doing the work. Hard ceiling of 50 protects against
                      // pathological retry loops but still allows hours of
                      // rate_limit recovery.
                      const meridianMaxSwitches = 50
                      if (reassignedTo) switches++
                      if (switches < meridianMaxSwitches) {
                        // Respect user abort BEFORE looping back. Without this,
                        // Ctrl+C during a reassign cycle only takes effect once
                        // the next LLM.stream() runs its own abort check.
                        input.abort.throwIfAborted()
                        continue
                      }
                      log.warn("meridian: exhausted retries after meridianMaxSwitches", {
                        sessionID: input.sessionID,
                        switches,
                      })
                      input.assistantMessage.error = error
                      Bus.publish(Session.Event.Error, { sessionID: input.sessionID, error })
                      input.assistantMessage.time.completed = Date.now()
                      await Session.updateMessage(input.assistantMessage)
                      return "stop"
                    }

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
