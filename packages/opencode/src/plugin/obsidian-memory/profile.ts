import { promises as fs } from "fs"
import path from "path"
import os from "os"

export interface UserProfile {
  static: string[]
  dynamic: string[]
  updatedAt: string
}

const FILE = "profile.json"
const MAX_DYNAMIC = 10
const MAX_STATIC = 50

function profilePath(vaultPath: string): string {
  const root = vaultPath.startsWith("~/") ? path.join(os.homedir(), vaultPath.slice(2)) : vaultPath
  return path.join(root, "_system", FILE)
}

export async function load(vaultPath: string): Promise<UserProfile> {
  const file = profilePath(vaultPath)
  try {
    const text = await fs.readFile(file, "utf8")
    const parsed = JSON.parse(text)
    return {
      static: Array.isArray(parsed.static) ? parsed.static.slice(0, MAX_STATIC) : [],
      dynamic: Array.isArray(parsed.dynamic) ? parsed.dynamic.slice(0, MAX_DYNAMIC) : [],
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    }
  } catch {
    return { static: [], dynamic: [], updatedAt: new Date().toISOString() }
  }
}

export async function save(vaultPath: string, profile: UserProfile): Promise<void> {
  const file = profilePath(vaultPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(profile, null, 2), "utf8")
}

export async function addStatic(vaultPath: string, fact: string): Promise<void> {
  const p = await load(vaultPath)
  if (p.static.includes(fact)) return
  p.static = [fact, ...p.static].slice(0, MAX_STATIC)
  p.updatedAt = new Date().toISOString()
  await save(vaultPath, p)
}

export async function addDynamic(vaultPath: string, fact: string): Promise<void> {
  const p = await load(vaultPath)
  p.dynamic = [fact, ...p.dynamic.filter((f) => f !== fact)].slice(0, MAX_DYNAMIC)
  p.updatedAt = new Date().toISOString()
  await save(vaultPath, p)
}

export function format(profile: UserProfile): string {
  if (profile.static.length === 0 && profile.dynamic.length === 0) return ""
  const parts: string[] = ["<user-profile>"]
  if (profile.static.length > 0) {
    parts.push("## Static (long-term)")
    profile.static.forEach((f) => parts.push(`- ${f}`))
  }
  if (profile.dynamic.length > 0) {
    parts.push("")
    parts.push("## Dynamic (recent)")
    profile.dynamic.forEach((f) => parts.push(`- ${f}`))
  }
  parts.push("</user-profile>")
  return parts.join("\n")
}
