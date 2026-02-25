import path from "path"
import { Global } from "../global"
import z from "zod"
import { Filesystem } from "../util/filesystem"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>
  export type InfoWithKey = Info & { _key: string }

  const filepath = path.join(Global.Path.data, "auth.json")

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    const data = await Filesystem.readJson<Record<string, unknown>>(filepath).catch(() => ({}))
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function set(key: string, info: Info) {
    const data = await all()
    await Filesystem.writeJson(filepath, { ...data, [key]: info }, 0o600)
  }

  export async function remove(key: string) {
    const data = await all()
    delete data[key]
    await Filesystem.writeJson(filepath, data, 0o600)
  }

  export async function list(providerID: string): Promise<Array<{ key: string; info: Info }>> {
    const data = await all()
    const result: Array<{ key: string; info: Info }> = []
    for (const [key, info] of Object.entries(data)) {
      if (key === providerID || key.startsWith(providerID + ":")) {
        result.push({ key, info })
      }
    }
    return result
  }

  export async function nextKey(providerID: string): Promise<string> {
    const entries = await list(providerID)
    if (entries.length === 0) return providerID
    let max = 0
    for (const entry of entries) {
      const sep = entry.key.indexOf(":")
      if (sep !== -1) max = Math.max(max, parseInt(entry.key.slice(sep + 1)) || 0)
    }
    return `${providerID}:${max + 1}`
  }
}
