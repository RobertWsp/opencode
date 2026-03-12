import { TextAttributes, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, onMount, Show, For } from "solid-js"
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
  const [branches, setBranches] = createSignal<string[]>([])
  const [idx, setIdx] = createSignal(0)
  const dims = useTerminalDimensions()

  let scroll: ScrollBoxRenderable | undefined

  function resolve() {
    const sym = Bun.spawnSync(["git", "symbolic-ref", "refs/remotes/origin/HEAD", "--short"], { cwd: process.cwd() })
    if (sym.exitCode === 0)
      return sym.stdout
        .toString()
        .trim()
        .replace(/^origin\//, "")
    const cfg = Bun.spawnSync(["git", "config", "init.defaultBranch"], { cwd: process.cwd() })
    if (cfg.exitCode === 0) return cfg.stdout.toString().trim()
    return "dev"
  }

  function move(dir: number) {
    const len = branches().length
    if (!len) return
    const next = (idx() + dir + len) % len
    setIdx(next)
    if (!scroll) return
    const target = scroll.getChildren().find((c) => c.id === String(next))
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1)
    if (y < 0) scroll.scrollBy(y)
  }

  useKeyboard((evt) => {
    if (loading()) return
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) move(1)
    if (evt.name === "return") submit()
  })

  onMount(() => {
    dialog.setSize("medium")
    const raw = Bun.spawnSync(["git", "branch", "-a", "--format=%(refname:short)"], { cwd: process.cwd() })
    const list = raw.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((b) => b && !b.includes("HEAD"))
      .filter((b, i, arr) => arr.indexOf(b) === i)
    setBranches(list)
    const base = resolve()
    const match = list.findIndex((b) => b === base || b === `origin/${base}`)
    if (match >= 0) setIdx(match)
  })

  async function submit() {
    if (loading()) return
    const base = branches()[idx()]
    if (!base) {
      setErr("No branch selected")
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
      <text fg={theme.textMuted}>Select base branch</text>
      <Show when={branches().length > 0} fallback={<text fg={theme.textMuted}>No branches found</text>}>
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          maxHeight={Math.min(branches().length, Math.floor(dims().height / 2) - 6)}
          scrollbarOptions={{ visible: false }}
        >
          <For each={branches()}>
            {(b, i) => (
              <box id={String(i())} flexDirection="row">
                <text
                  fg={i() === idx() ? theme.primary : theme.textMuted}
                  attributes={i() === idx() ? TextAttributes.BOLD : undefined}
                >
                  {i() === idx() ? "\u276F " : "  "}
                  {b}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
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
