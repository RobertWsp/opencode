import { Log } from "../util/log"

const log = Log.create({ service: "caveman-state" })

export namespace CavemanState {
  type Info = { off: boolean; at: number }
  const TTL_MS = 24 * 60 * 60 * 1000
  const map = new Map<string, Info>()
  let calls = 0

  function gc() {
    const now = Date.now()
    for (const [id, info] of map.entries()) {
      if (now - info.at > TTL_MS) map.delete(id)
    }
  }

  export function disable(sessionID: string) {
    map.set(sessionID, { off: true, at: Date.now() })
    log.info("caveman disabled", { sessionID })
  }

  export function enable(sessionID: string) {
    map.set(sessionID, { off: false, at: Date.now() })
    log.info("caveman re-enabled", { sessionID })
  }

  export function disabled(sessionID: string, ancestors: string[] = []): boolean {
    for (const id of [sessionID, ...ancestors]) {
      const info = map.get(id)
      if (!info) continue
      if (Date.now() - info.at > TTL_MS) {
        map.delete(id)
        continue
      }
      if (info.off) return true
    }
    return false
  }

  export function clear(sessionID: string) {
    map.delete(sessionID)
  }

  export function touch() {
    calls++
    if (calls % 100 === 0) gc()
  }

  export function _reset() {
    map.clear()
    calls = 0
  }
}
