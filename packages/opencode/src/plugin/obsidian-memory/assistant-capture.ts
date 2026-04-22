import { Database } from "bun:sqlite"
import path from "path"
import os from "os"
import { Log } from "../../util/log"
import type { CaptureEventInput } from "./capture-gate"

const log = Log.create({ service: "plugin.obsidian-memory.assistant" })

const MIN_LEN = 180
const MAX_LEN = 1800
const MAX_MESSAGES = 20

const SIGNALS = [
  /\b(decidi|escolhi|optei|chose|decided|going to use|vou usar|optamos|we will use)\b/i,
  /\b(because|porque|pois|since the|because the)\b/i,
  /\b(gotcha|pitfall|cuidado|atenção|warning|caveat|important note|note that)\b/i,
  /\b(fixed|corrigi|consertei|resolved|solved|workaround)\b/i,
  /\b(convention|pattern|padrão|sempre|nunca|always|never do)\b/i,
  /\b(root cause|causa raiz|turns out|the issue was)\b/i,
  /\b(migrated|migration|switched|migrei|mudei|replaced)\b/i,
]

function hasSignal(text: string): boolean {
  return SIGNALS.some((re) => re.test(text))
}

function dbPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
}

export interface AssistantText {
  messageID: string
  text: string
  timeCreated: number
}

export function recentAssistantTexts(sessionID: string, limit = MAX_MESSAGES): AssistantText[] {
  const p = dbPath()
  let db: Database
  try {
    db = new Database(p, { readonly: true })
  } catch (err) {
    log.warn("db open failed", { error: String(err) })
    return []
  }
  try {
    const msgRows = db
      .query<{ id: string; time_created: number }, [string, number]>(
        `SELECT id, time_created FROM message
         WHERE session_id = ?1 AND json_extract(data, '$.role') = 'assistant'
         ORDER BY time_created DESC LIMIT ?2`,
      )
      .all(sessionID, limit)

    if (msgRows.length === 0) return []

    const out: AssistantText[] = []
    for (const m of msgRows) {
      const parts = db
        .query<{ text: string | null }, [string]>(
          `SELECT json_extract(data, '$.text') as text FROM part
           WHERE message_id = ?1 AND json_extract(data, '$.type') = 'text'
           ORDER BY time_created ASC`,
        )
        .all(m.id)
      const joined = parts
        .map((x) => x.text ?? "")
        .filter(Boolean)
        .join("\n")
        .trim()
      if (joined.length >= MIN_LEN && joined.length <= MAX_LEN * 4 && hasSignal(joined)) {
        out.push({ messageID: m.id, text: joined.slice(0, MAX_LEN), timeCreated: m.time_created })
      }
    }
    return out
  } finally {
    db.close()
  }
}

export function toCaptureEvents(sessionID: string, texts: AssistantText[]): CaptureEventInput[] {
  return texts.map((t) => ({
    sessionID,
    kind: "chat.response" as const,
    summary: t.text,
    details: {
      role: "assistant",
      messageID: t.messageID,
      fullLength: String(t.text.length),
    },
    timestamp: t.timeCreated,
  }))
}
