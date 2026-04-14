/**
 * Router notification queue — bridges the oh-my-opencode model-router
 * plugin with the fork's session processor so routing decisions can be
 * rendered as synthetic notifications in the conversation history
 * (same pattern as account switch notifications).
 *
 * The plugin runs inside the opencode process but cannot import from
 * the fork's internal modules. Instead, both sides agree on a globalThis
 * property as a shared queue.
 *
 * Flow:
 *   1. model-router hook decides a tier, then pushes a notification
 *      via `globalThis.__OPENCODE_ROUTER_NOTIFICATIONS__.push(...)`
 *   2. Processor.create() starts streaming — before the first event,
 *      it calls `consume(sessionID)` and inserts each pending message
 *      as a synthetic text part on the assistant message.
 *
 * Why a module-level Map instead of globalThis storage directly?
 *   - Type safety: we own the type and API
 *   - Cleanup: entries expire after being consumed
 *   - Testability: clearAll() for tests
 */

const GLOBAL_KEY = "__OPENCODE_ROUTER_NOTIFICATIONS__"

interface NotificationEntry {
  text: string
  pushedAt: number
}

interface NotificationApi {
  push(sessionID: string, text: string): void
  consume(sessionID: string): NotificationEntry[]
  clearAll(): void
  size(): number
}

function createApi(): NotificationApi {
  const queue = new Map<string, NotificationEntry[]>()

  return {
    push(sessionID: string, text: string) {
      if (!sessionID || !text) return
      const list = queue.get(sessionID) ?? []
      list.push({ text, pushedAt: Date.now() })
      queue.set(sessionID, list)
    },

    consume(sessionID: string): NotificationEntry[] {
      const entries = queue.get(sessionID)
      if (!entries || entries.length === 0) return []
      queue.delete(sessionID)
      return entries
    },

    clearAll() {
      queue.clear()
    },

    size(): number {
      let total = 0
      for (const list of queue.values()) total += list.length
      return total
    },
  }
}

// Install once on globalThis so the plugin (which imports nothing from
// the fork's internals) can find us.
const g = globalThis as unknown as Record<string, NotificationApi | undefined>
if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = createApi()
}

export const RouterNotifications = g[GLOBAL_KEY] as NotificationApi
