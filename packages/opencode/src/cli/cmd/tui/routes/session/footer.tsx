import { createEffect, createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/dialog-model"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { useRoutingDecision, type TierBadge } from "../../context/routing-decision"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const routing = useRoutingDecision()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()

  // Sync the active session with the routing decision context so the
  // polling reader only considers decisions from the current session.
  createEffect(() => {
    if (route.data.type === "session") {
      routing.setActiveSession(route.data.sessionID)
    } else {
      routing.setActiveSession(null)
    }
  })

  const routerLastDecision = createMemo(() => routing.lastDecision())
  const routerOverride = createMemo(() => routing.override())

  function tierColor(tier: TierBadge | undefined) {
    if (!tier) return theme.textMuted
    switch (tier) {
      case "opus":
        return theme.warning
      case "opus-plan":
        return theme.accent
      case "sonnet":
        return theme.info
      case "haiku":
        return theme.success
    }
  }

  const routerBadge = createMemo(() => {
    const override = routerOverride()
    if (override) {
      return { tier: override.tier, reason: "pinned", conf: 0 }
    }
    const d = routerLastDecision()
    if (!d) return null
    const firstReason = d.reasons[0] ?? "default"
    const colon = firstReason.indexOf(":")
    return {
      tier: d.tier,
      reason: colon > 0 ? firstReason.slice(colon + 1) : firstReason,
      conf: d.confidence,
    }
  })

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <Show when={routerBadge()}>
              {(badge) => (
                <text fg={theme.text}>
                  <span style={{ fg: tierColor(badge().tier) }}>◆ </span>
                  <span style={{ fg: tierColor(badge().tier) }}>{badge().tier}</span>
                  <span style={{ fg: theme.textMuted }}> ← {badge().reason}</span>
                </text>
              )}
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
