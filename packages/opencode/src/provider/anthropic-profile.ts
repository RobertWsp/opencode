/**
 * Anthropic OAuth profile resolver.
 *
 * Resolves the email address associated with an Anthropic OAuth entry.
 * Three resolution strategies, in order of speed:
 *   1. in-memory cache
 *   2. `email` field on the auth.json entry (already cached)
 *   3. local Claude config dirs — walk ~/.claude and Meridian profile
 *      dirs looking for a .credentials.json whose refreshToken matches
 *      this auth entry, then read emailAddress from the sibling
 *      .claude.json. Instant (no network), works with stale tokens.
 *   4. live fetch against `api.anthropic.com/api/oauth/profile` — last
 *      resort when no local match exists.
 *
 * Email results are persisted to auth.json so later starts skip to (2).
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { Log } from "../util/log"
import { Auth } from "../auth"

const log = Log.create({ service: "anthropic.profile" })

const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile"

// Resolved emails cached in-memory for the life of the process, keyed by
// auth key ("anthropic", "anthropic:1", ...). Avoids repeat fetches on
// every pool rebuild within the same session.
const memoryCache = new Map<string, string>()
const inflight = new Map<string, Promise<string | undefined>>()

/**
 * Best-effort lookup of the email for an Anthropic OAuth entry. Uses
 * (in order): in-memory cache → cached `email` field on Auth entry →
 * live fetch from the Anthropic profile endpoint.
 *
 * Returns undefined if the lookup fails — callers should fall back to a
 * generic label. Never throws.
 */
export async function resolveEmail(
  authKey: string,
  accessToken: string,
  refreshToken?: string,
): Promise<string | undefined> {
  const cached = memoryCache.get(authKey)
  if (cached) return cached

  const existing = await Auth.get(authKey).catch(() => undefined)
  if (existing?.type === "oauth" && existing.email) {
    memoryCache.set(authKey, existing.email)
    return existing.email
  }

  // Local match: Meridian and the base Claude config both persist
  // `claudeAiOauth.refreshToken` alongside `.claude.json` with the real
  // `oauthAccount.emailAddress`. Walk those dirs to find a match — 10ms,
  // no network, works even if the access token is stale.
  if (refreshToken) {
    const localMatch = resolveEmailFromLocalConfig(refreshToken)
    if (localMatch) {
      memoryCache.set(authKey, localMatch)
      // Persist to auth.json so next start is instant.
      const current = await Auth.get(authKey).catch(() => undefined)
      if (current?.type === "oauth" && current.email !== localMatch) {
        await Auth.set(authKey, { ...current, email: localMatch }).catch(() => {
          /* non-fatal */
        })
      }
      return localMatch
    }
  }

  const pending = inflight.get(authKey)
  if (pending) return pending

  const fetching = fetchAndCache(authKey, accessToken)
  inflight.set(authKey, fetching)
  fetching.finally(() => inflight.delete(authKey))
  return fetching
}

/**
 * Scan local Claude config dirs for a .credentials.json whose refreshToken
 * matches, then return the neighboring .claude.json oauthAccount email.
 * Covers ~/.claude (main) and every Meridian profile dir.
 * Synchronous + best-effort: any IO error is swallowed.
 */
function resolveEmailFromLocalConfig(refreshToken: string): string | undefined {
  const home = process.env.HOME ?? os.homedir()
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
  const candidates: string[] = [path.join(home, ".claude")]
  const meridianProfiles = path.join(xdg, "meridian", "profiles")
  try {
    for (const name of fs.readdirSync(meridianProfiles)) {
      if (name.endsWith(".disabled") || name.endsWith(".lock")) continue
      const full = path.join(meridianProfiles, name)
      try {
        if (fs.statSync(full).isDirectory()) candidates.push(full)
      } catch {
        /* skip */
      }
    }
  } catch {
    /* meridian dir may not exist */
  }
  for (const dir of candidates) {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"))
      const rt = creds?.claudeAiOauth?.refreshToken ?? creds?.refreshToken
      if (rt !== refreshToken) continue
      const config = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"))
      const email = config?.oauthAccount?.emailAddress
      if (typeof email === "string" && email.length > 0) return email
    } catch {
      /* skip this candidate */
    }
  }
  return undefined
}

// OAuth token endpoint + client id — matches plugin/anthropic.ts so we
// reuse the same refresh flow the main provider uses.
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const OAUTH_BETA = "oauth-2025-04-20"

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ access: string; refresh: string; expires: number } | undefined> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    })
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return undefined
    const data = (await res.json().catch(() => null)) as
      | { access_token?: string; refresh_token?: string; expires_in?: number }
      | null
    if (!data?.access_token) return undefined
    return {
      access: data.access_token,
      refresh: data.refresh_token ?? refreshToken,
      expires: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
  } catch {
    return undefined
  }
}

async function fetchProfileWithToken(accessToken: string): Promise<string | undefined> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    const res = await fetch(PROFILE_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}`, "anthropic-beta": OAUTH_BETA },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return undefined
    const data = (await res.json().catch(() => null)) as { account?: { email_address?: string } } | null
    return data?.account?.email_address
  } catch {
    return undefined
  }
}

async function fetchAndCache(authKey: string, accessToken: string): Promise<string | undefined> {
  try {
    // First attempt with the current access token.
    let email = await fetchProfileWithToken(accessToken)

    // If that failed (expired/invalid), try a refresh-then-retry.
    if (!email) {
      const current = await Auth.get(authKey).catch(() => undefined)
      if (current?.type === "oauth" && current.refresh) {
        const refreshed = await refreshAccessToken(current.refresh)
        if (refreshed) {
          email = await fetchProfileWithToken(refreshed.access)
          // Persist refreshed tokens — skips refresh on subsequent calls.
          await Auth.set(authKey, {
            ...current,
            access: refreshed.access,
            refresh: refreshed.refresh,
            expires: refreshed.expires,
          }).catch(() => {
            /* non-fatal */
          })
        }
      }
    }

    if (!email) {
      log.info("profile fetch failed", { authKey })
      return undefined
    }

    memoryCache.set(authKey, email)
    const current = await Auth.get(authKey).catch(() => undefined)
    if (current?.type === "oauth" && current.email !== email) {
      await Auth.set(authKey, { ...current, email }).catch((err) => {
        log.warn("failed to persist email cache", { authKey, error: String(err) })
      })
    }
    return email
  } catch (err) {
    log.info("profile fetch failed", { authKey, error: String(err) })
    return undefined
  }
}
