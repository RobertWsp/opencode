import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useRoutingDecision, type TierBadge } from "../context/routing-decision"
import { DialogRoutingInspector } from "./dialog-routing-inspector"
import { DialogRoutingStats } from "./dialog-routing-stats"

/**
 * `/model` dialog — subcommand picker.
 *
 * Subcommands:
 *   - auto       : clear manual override; let the router decide
 *   - opus       : pin to Opus for the session
 *   - sonnet     : pin to Sonnet
 *   - haiku      : pin to Haiku
 *   - opus-plan  : use the architect/editor pattern
 *   - status     : open the decision inspector modal
 *   - stats      : open the stats modal (distribution + success rates)
 *   - reset      : force re-analysis on the next turn
 */

type Subcommand =
  | { kind: "tier"; tier: TierBadge | "auto"; label: string; description: string }
  | { kind: "view"; view: "status" | "stats"; label: string; description: string }
  | { kind: "action"; action: "reset"; label: string; description: string }

const SUBCOMMANDS: Subcommand[] = [
  { kind: "tier", tier: "auto", label: "auto", description: "Use the router (clear manual pin)" },
  { kind: "tier", tier: "opus", label: "opus", description: "Pin to Claude Opus 4.6 (deep reasoning)" },
  { kind: "tier", tier: "opus-plan", label: "opus-plan", description: "Opus for planning, Sonnet for execution" },
  { kind: "tier", tier: "sonnet", label: "sonnet", description: "Pin to Claude Sonnet 4.6 (workhorse)" },
  { kind: "tier", tier: "haiku", label: "haiku", description: "Pin to Claude Haiku 4.5 (fast)" },
  { kind: "view", view: "status", label: "status", description: "Show current routing decision details" },
  { kind: "view", view: "stats", label: "stats", description: "Show routing stats (distribution, success rates)" },
  { kind: "action", action: "reset", label: "reset", description: "Force re-analysis on the next turn" },
]

export function DialogModelRouter() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const routing = useRoutingDecision()

  const current = createMemo(() => {
    const override = routing.override()
    if (override) return `pinned: ${override.tier}`
    const last = routing.lastDecision()
    if (last) return `router: ${last.tier}`
    return "router: (no decisions yet)"
  })

  function handleSelect(sub: Subcommand) {
    if (sub.kind === "tier") {
      if (sub.tier === "auto") {
        routing.clearOverride()
      } else {
        routing.setOverride(sub.tier, "session")
      }
      dialog.clear()
      return
    }
    if (sub.kind === "view" && sub.view === "status") {
      dialog.replace(() => <DialogRoutingInspector />)
      return
    }
    if (sub.kind === "view" && sub.view === "stats") {
      dialog.replace(() => <DialogRoutingStats />)
      return
    }
    if (sub.kind === "action" && sub.action === "reset") {
      // Force re-analysis: route state machine will re-run on next turn
      // because the override cleared. For explicit "reset" we also clear cache
      // on the next decision by simply clearing override.
      routing.clearOverride()
      dialog.clear()
    }
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Model Router
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc to close
        </text>
      </box>

      <text fg={theme.textMuted}>
        Current: <span style={{ fg: theme.text, bold: true }}>{current()}</span>
      </text>

      <box paddingTop={1} gap={0}>
        <For each={SUBCOMMANDS}>
          {(sub) => (
            <box
              flexDirection="row"
              gap={2}
              paddingLeft={1}
              paddingRight={1}
              onMouseUp={() => handleSelect(sub)}
            >
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {sub.label.padEnd(12)}
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                {sub.description}
              </text>
            </box>
          )}
        </For>
      </box>

      <Show when={routing.lastDecision()}>
        {(decision) => (
          <box paddingTop={1}>
            <text fg={theme.textMuted}>
              Last decision reasons: {decision().reasons.slice(0, 3).join(", ")}
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}
