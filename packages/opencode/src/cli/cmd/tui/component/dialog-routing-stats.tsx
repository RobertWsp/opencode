import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo, createResource } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useRoutingDecision, type RoutingDecisionRecord, type TierBadge } from "../context/routing-decision"

/**
 * Routing Stats — aggregated distribution across recent decisions
 * (session-scoped). Shows:
 *   - Tier distribution bar chart
 *   - Analyzer latency avg/max
 *   - Rules fallback rate
 *   - Most common decision reasons
 */

type TierStats = Record<TierBadge, number>

function emptyTierStats(): TierStats {
  return { haiku: 0, sonnet: 0, opus: 0, "opus-plan": 0 }
}

export function DialogRoutingStats() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const routing = useRoutingDecision()

  dialog.setSize("large")

  const [decisions] = createResource(async () => await routing.getAllDecisionsForSession())

  const stats = createMemo(() => {
    const all = decisions() ?? []
    const total = all.length
    const tierDist: TierStats = emptyTierStats()
    let totalAnalyzerMs = 0
    let analyzerUsedCount = 0
    let fallbackCount = 0
    let cachedCount = 0
    const reasonCounts = new Map<string, number>()

    for (const d of all) {
      tierDist[d.tier] = (tierDist[d.tier] ?? 0) + 1
      if (d.analyzer.used) {
        analyzerUsedCount++
        totalAnalyzerMs += d.analyzer.durationMs
      }
      if (d.analyzer.fallbackUsed) fallbackCount++
      if (d.analyzer.cached) cachedCount++
      for (const reason of d.reasons) {
        const cat = reason.split(":")[0] ?? reason
        reasonCounts.set(cat, (reasonCounts.get(cat) ?? 0) + 1)
      }
    }

    const topReasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    return {
      total,
      tierDist,
      avgAnalyzerMs: analyzerUsedCount > 0 ? Math.round(totalAnalyzerMs / analyzerUsedCount) : 0,
      fallbackCount,
      cachedCount,
      topReasons,
    }
  })

  function bar(count: number, total: number, width: number = 20): string {
    if (total === 0) return ""
    const filled = Math.round((count / total) * width)
    return "█".repeat(filled) + "░".repeat(width - filled)
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Routing Stats (current session)
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc to close
        </text>
      </box>

      <Show
        when={stats().total > 0}
        fallback={
          <box paddingTop={1}>
            <text fg={theme.textMuted}>No decisions yet. Ask something to generate data.</text>
          </box>
        }
      >
        <box gap={0} paddingTop={1}>
          <text fg={theme.text}>Total decisions: {stats().total}</text>
        </box>

        <box gap={0} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Tier distribution
          </text>
          <For each={(["opus", "opus-plan", "sonnet", "haiku"] as TierBadge[])}>
            {(tier) => {
              const count = stats().tierDist[tier] ?? 0
              const pct = stats().total > 0 ? ((count / stats().total) * 100).toFixed(0) : "0"
              return (
                <text fg={theme.text}>
                  {"  "}{tier.padEnd(10)}{" "}
                  <span style={{ fg: theme.textMuted }}>{bar(count, stats().total)}</span>{" "}
                  {count} ({pct}%)
                </text>
              )
            }}
          </For>
        </box>

        <box gap={0} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Analyzer
          </text>
          <text fg={theme.textMuted}>
            {"  "}avg latency: {stats().avgAnalyzerMs}ms · fallbacks: {stats().fallbackCount} · cache hits: {stats().cachedCount}
          </text>
        </box>

        <box gap={0} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Top decision reasons
          </text>
          <For each={stats().topReasons}>
            {(r) => (
              <text fg={theme.textMuted}>
                {"  "}{r[0].padEnd(15)} {r[1]}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
