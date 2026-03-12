import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onMount, Show } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useRoute } from "@tui/context/route"
import { useTheme } from "../context/theme"

export function DialogWorktreeCreate() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const route = useRoute()
  const { theme } = useTheme()
  const [loading, setLoading] = createSignal(false)
  const [err, setErr] = createSignal("")

  let input: TextareaRenderable

  useKeyboard((evt) => {
    if (loading()) return
    if (evt.name === "return") {
      submit()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.focus()
    }, 1)
    input.gotoLineEnd()
  })

  async function submit() {
    if (loading()) return
    const base = input.plainText.trim()
    if (!base) {
      setErr("Base branch is required")
      return
    }

    setLoading(true)
    setErr("")

    const ws = await sdk.client.experimental.workspace.create({
      type: "worktree",
      branch: null,
      extra: { baseBranch: base },
    })
    if (!ws.data) {
      setErr("Failed to create workspace")
      setLoading(false)
      return
    }

    const session = await sdk.client.session.create({
      workspace: ws.data.id,
    })
    if (!session.data) {
      setErr("Failed to create session")
      setLoading(false)
      return
    }

    dialog.clear()
    route.navigate({ type: "session", sessionID: session.data.id })
    toast.show({
      variant: "success",
      message: `Worktree created: ${ws.data.branch} (from ${base})`,
    })
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Create Worktree
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <text fg={theme.textMuted}>Base branch</text>
        <textarea
          onSubmit={() => submit()}
          height={3}
          keyBindings={[{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => (input = val)}
          initialValue=""
          placeholder="Branch to base worktree on"
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
      </box>
      <Show when={err()}>
        <text fg={theme.error}>{err()}</text>
      </Show>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!loading()} fallback={<text fg={theme.textMuted}>Creating worktree...</text>}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>create</span>
          </text>
        </Show>
      </box>
    </box>
  )
}
