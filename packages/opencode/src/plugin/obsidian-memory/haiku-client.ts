import { readFile } from "fs/promises"
import { homedir } from "os"
import path from "path"

/**
 * Minimal Anthropic client for plugin background work (capture gate,
 * consolidation). Two transports:
 *
 * 1. Meridian bridge via `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` env vars
 *    (preferred — benefits from account pool + rate-limit handling)
 * 2. Direct OAuth to api.anthropic.com using credentials from
 *    `~/.claude/.credentials.json` (fallback, mirrors model-router pattern)
 *
 * Kept separate from the main opencode provider flow on purpose: this client
 * is invisible to the user-facing session and should never interfere with
 * the main chat loop.
 */

const CREDENTIALS_PATH = path.join(homedir(), ".claude", ".credentials.json")
const CRED_CACHE_TTL_MS = 30_000

interface OAuthCreds {
  accessToken: string
  expiresAt?: number
}

let credCache: { creds: OAuthCreds | null; readAt: number } | null = null

async function readOAuthCreds(): Promise<OAuthCreds | null> {
  if (credCache && Date.now() - credCache.readAt < CRED_CACHE_TTL_MS) {
    return credCache.creds
  }
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf8")
    const parsed = JSON.parse(raw) as { claudeAiOauth?: OAuthCreds }
    const creds = parsed.claudeAiOauth ?? null
    if (!creds || !creds.accessToken) {
      credCache = { creds: null, readAt: Date.now() }
      return null
    }
    if (creds.expiresAt && creds.expiresAt < Date.now() + 60_000) {
      credCache = { creds: null, readAt: Date.now() }
      return null
    }
    credCache = { creds, readAt: Date.now() }
    return creds
  } catch {
    credCache = { creds: null, readAt: Date.now() }
    return null
  }
}

export interface HaikuCallArgs {
  model: string
  systemPrompt: string
  userMessage: string
  maxTokens?: number
  timeoutMs?: number
}

export interface HaikuCallResult {
  ok: boolean
  text?: string
  error?: string
  durationMs: number
}

/**
 * Make a single request to an Anthropic Messages endpoint. Returns the
 * joined text of the first message. No streaming, no tool use — just
 * plain text completion optimized for background analysis.
 */
export async function callHaiku(args: HaikuCallArgs): Promise<HaikuCallResult> {
  const started = Date.now()
  const timeoutMs = args.timeoutMs ?? 15_000
  const maxTokens = args.maxTokens ?? 512

  const body = JSON.stringify({
    model: args.model,
    max_tokens: maxTokens,
    system: args.systemPrompt,
    messages: [{ role: "user", content: args.userMessage }],
  })

  // Transport 1: Meridian
  const mBase = process.env.ANTHROPIC_BASE_URL
  const mKey = process.env.ANTHROPIC_API_KEY
  if (mBase && mKey) {
    const result = await post({
      endpoint: `${mBase.replace(/\/$/, "")}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": mKey,
        "anthropic-version": "2023-06-01",
        "x-memory-background": "true",
      },
      body,
      timeoutMs,
      started,
    })
    if (result.ok || !result.error?.startsWith("HTTP 429")) return result
  }

  // Transport 2: Direct OAuth
  const creds = await readOAuthCreds()
  if (!creds) {
    return {
      ok: false,
      error: "no transport available (no Meridian env vars + no ~/.claude/.credentials.json)",
      durationMs: Date.now() - started,
    }
  }

  // Anthropic requires the system prompt to start with the Claude Code
  // marker when calling with an OAuth token directly (third-party detection).
  const oauthSystem = `You are Claude Code, Anthropic's official CLI for Claude.\n\n${args.systemPrompt}`
  const oauthBody = JSON.stringify({
    model: args.model,
    max_tokens: maxTokens,
    system: oauthSystem,
    messages: [{ role: "user", content: args.userMessage }],
  })

  return post({
    endpoint: "https://api.anthropic.com/v1/messages",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.107 (external, cli)",
    },
    body: oauthBody,
    timeoutMs,
    started,
  })
}

async function post(args: {
  endpoint: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  started: number
}): Promise<HaikuCallResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs)
  try {
    const response = await fetch(args.endpoint, {
      method: "POST",
      headers: args.headers,
      body: args.body,
      signal: controller.signal,
    })
    if (!response.ok) {
      const snippet = await response.text().catch(() => "")
      return {
        ok: false,
        error: `HTTP ${response.status}: ${snippet.slice(0, 200)}`,
        durationMs: Date.now() - args.started,
      }
    }
    const json = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = (json.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("")
    return {
      ok: true,
      text,
      durationMs: Date.now() - args.started,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: message.includes("aborted") ? "timeout" : message,
      durationMs: Date.now() - args.started,
    }
  } finally {
    clearTimeout(timer)
  }
}
