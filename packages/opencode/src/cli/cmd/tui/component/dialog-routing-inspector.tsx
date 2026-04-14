import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useRoutingDecision, type TierBadge } from "../context/routing-decision"

/**
 * Routing Inspector — shows the full TaskAnalysis for the most recent
 * decision in the current session. Every dimension is listed with its
 * evidence. Useful for auditing why the router picked a specific tier.
 */

function tierColor(tier: TierBadge | undefined, theme: any) {
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

export function DialogRoutingInspector() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const routing = useRoutingDecision()

  // Make it large so the scroll content has room
  dialog.setSize("large")

  const decision = createMemo(() => routing.lastDecision())

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Routing Decision Inspector
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc to close
        </text>
      </box>

      <Show
        when={decision()}
        fallback={
          <box paddingTop={1}>
            <text fg={theme.textMuted}>
              No routing decisions yet for this session. Ask something to generate one.
            </text>
          </box>
        }
      >
        {(d) => (
          <box gap={1}>
            {/* Header */}
            <box flexDirection="row" gap={2}>
              <text fg={tierColor(d().tier, theme)} attributes={TextAttributes.BOLD}>
                {d().tier.toUpperCase()}
              </text>
              <text fg={theme.textMuted}>
                {d().modelID}
              </text>
              <text fg={theme.textMuted}>
                turn {d().turnNumber} · agent {d().agent}
              </text>
            </box>

            {/* Decision reasons */}
            <box gap={0} paddingTop={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Decision rules fired
              </text>
              <For each={d().reasons}>
                {(reason) => (
                  <text fg={theme.textMuted}>  · {reason}</text>
                )}
              </For>
            </box>

            {/* Analyzer info */}
            <box gap={0} paddingTop={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Analyzer
              </text>
              <text fg={theme.textMuted}>
                {"  "}used: {d().analyzer.used ? "yes" : "no"}
                {" · "}duration: {d().analyzer.durationMs}ms
                {" · "}fallback: {d().analyzer.fallbackUsed ? "yes" : "no"}
                {d().analyzer.cached ? " · cached" : ""}
              </text>
              <Show when={d().analyzer.error}>
                <text fg={theme.error}>  error: {d().analyzer.error}</text>
              </Show>
            </box>

            {/* Analysis dimensions */}
            <Show when={d().analysis}>
              {(a) => (
                <box gap={0} paddingTop={1}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    Task Analysis ({Math.round(d().confidence * 100)}% confidence)
                  </text>
                  <Dim label="task_type" value={a().task_type} evidence={a().task_type_evidence} theme={theme} />
                  <Dim
                    label="reasoning_depth"
                    value={a().reasoning_depth}
                    evidence={a().reasoning_depth_evidence}
                    theme={theme}
                  />
                  <Dim label="scope_breadth" value={a().scope_breadth} theme={theme} />
                  <Dim
                    label="est_files"
                    value={a().estimated_files_touched !== null ? String(a().estimated_files_touched) : "n/a"}
                    theme={theme}
                  />
                  <Dim label="context" value={a().context_requirements} theme={theme} />
                  <Dim
                    label="ambiguity"
                    value={a().ambiguity}
                    evidence={a().ambiguity_reasons.join(", ")}
                    theme={theme}
                  />
                  <Dim
                    label="risk"
                    value={a().risk_level}
                    evidence={a().risk_justification}
                    theme={theme}
                  />
                  <Dim label="novelty" value={a().novelty} theme={theme} />
                  <Dim label="domain" value={a().domain_expertise} theme={theme} />
                  <Dim label="iteration" value={a().iteration_profile} theme={theme} />

                  <box paddingTop={1} flexDirection="column" gap={0}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Primary reasoning
                    </text>
                    <text fg={theme.text} wrapMode="word">
                      {a().primary_reasoning}
                    </text>
                  </box>
                  <box paddingTop={1} flexDirection="column" gap={0}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Contrarian check
                    </text>
                    <text fg={theme.textMuted} wrapMode="word">
                      {a().contrarian_check}
                    </text>
                  </box>
                </box>
              )}
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}

function Dim(props: { label: string; value: string; evidence?: string; theme: any }) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.theme.textMuted}>  {props.label.padEnd(16)}</text>
      <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
        {props.value}
      </text>
      <Show when={props.evidence}>
        <text fg={props.theme.textMuted} wrapMode="word">
           · {props.evidence}
        </text>
      </Show>
    </box>
  )
}
