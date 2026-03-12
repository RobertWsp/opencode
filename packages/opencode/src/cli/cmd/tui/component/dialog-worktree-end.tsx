import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onMount, Show, Switch, Match } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"

type Phase =
  | { type: "loading" }
  | { type: "clean" }
  | { type: "menu" }
  | { type: "review"; output: string }
  | { type: "pushing"; target: "pr" | "only" }
  | { type: "pushed"; output: string }
  | { type: "confirm" }

export function DialogWorktreeEnd(props: { sessionID: string; workspaceID: string; onDone: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()

  const [phase, setPhase] = createSignal<Phase>({ type: "loading" })
  const [changes, setChanges] = createSignal(0)
  const [unpushed, setUnpushed] = createSignal(0)
  const [dir, setDir] = createSignal("")
  const [branch, setBranch] = createSignal("")
  const [base, setBase] = createSignal("dev")
  const [selected, setSelected] = createSignal(0)
  const [err, setErr] = createSignal("")

  const options = [
    { title: "Review Changes", value: "review" },
    { title: "Push Branch & Create PR", value: "pr" },
    { title: "Push Only", value: "push" },
    { title: "Keep Worktree", value: "keep" },
    { title: "Discard All", value: "discard" },
  ] as const

  onMount(async () => {
    dialog.setSize("large")
    const list = await sdk.client.experimental.workspace.list()
    const ws = (list.data ?? []).find((w) => w.id === props.workspaceID)
    if (!ws?.directory) {
      toast.show({ message: "Workspace not found", variant: "error" })
      props.onDone()
      return
    }

    setDir(ws.directory)
    setBranch(ws.branch ?? "unknown")
    setBase((ws.extra as { baseBranch?: string })?.baseBranch ?? "dev")

    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: ws.directory })
    const dirty = status.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
    setChanges(dirty.length)

    const log = Bun.spawnSync(["git", "log", "--oneline", "--not", "--remotes"], { cwd: ws.directory })
    const commits = log.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
    setUnpushed(commits.length)

    if (dirty.length === 0 && commits.length === 0) {
      setPhase({ type: "clean" })
      props.onDone()
      return
    }

    setPhase({ type: "menu" })
  })

  function review() {
    const diff = Bun.spawnSync(["git", "diff", "--stat"], { cwd: dir() })
    const staged = Bun.spawnSync(["git", "diff", "--stat", "--cached"], { cwd: dir() })
    const output = [diff.stdout.toString().trim(), staged.stdout.toString().trim()]
      .filter((s) => s)
      .join("\n\nStaged:\n")
    setPhase({ type: "review", output: output || "No changes" })
  }

  async function push(mode: "pr" | "only") {
    setPhase({ type: "pushing", target: mode })
    setErr("")
    const result = Bun.spawnSync(["git", "push", "-u", "origin", branch()], { cwd: dir() })
    const out = result.stdout.toString() + result.stderr.toString()
    if (result.exitCode !== 0) {
      setErr(out || "Push failed")
      setPhase({ type: "menu" })
      return
    }

    if (mode === "pr") {
      const url = extractRemote(out, branch())
      setPhase({ type: "pushed", output: url || `Pushed ${branch()}. Create PR manually on remote.` })
      return
    }

    toast.show({ message: `Pushed ${branch()}`, variant: "success" })
    props.onDone()
  }

  async function discard() {
    setErr("")
    await sdk.client.experimental.workspace.remove({ id: props.workspaceID })
    toast.show({ message: "Worktree discarded", variant: "success" })
    props.onDone()
  }

  useKeyboard((evt) => {
    const p = phase()

    if (p.type === "review" || p.type === "pushed") {
      if (evt.name === "escape" || evt.name === "return") {
        setPhase({ type: "menu" })
      }
      return
    }

    if (p.type === "confirm") {
      if (evt.name === "y") {
        discard()
        return
      }
      setPhase({ type: "menu" })
      return
    }

    if (p.type !== "menu") return

    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      setSelected((s) => (s > 0 ? s - 1 : options.length - 1))
      return
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      setSelected((s) => (s < options.length - 1 ? s + 1 : 0))
      return
    }

    if (evt.name === "return") {
      const opt = options[selected()]
      if (opt.value === "review") return review()
      if (opt.value === "pr") return void push("pr")
      if (opt.value === "push") return void push("only")
      if (opt.value === "keep") {
        dialog.clear()
        props.onDone()
        return
      }
      if (opt.value === "discard") {
        setPhase({ type: "confirm" })
        return
      }
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          End Worktree Session
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Switch>
        <Match when={phase().type === "loading"}>
          <text fg={theme.textMuted}>Checking worktree status...</text>
        </Match>

        <Match when={phase().type === "menu" || phase().type === "pushing"}>
          <box gap={0}>
            <text fg={changes() > 0 || unpushed() > 0 ? theme.warning : theme.success}>
              {changes() > 0 || unpushed() > 0
                ? `⚠ ${changes()} files changed, ${unpushed()} unpushed commits`
                : "✓ Clean"}
            </text>
            <text fg={theme.textMuted}>
              {branch()} → {base()}
            </text>
          </box>

          <Show when={phase().type !== "pushing"} fallback={<text fg={theme.textMuted}>Pushing...</text>}>
            <box gap={0}>
              {options.map((opt, i) => (
                <box
                  flexDirection="row"
                  onMouseUp={() => {
                    setSelected(i)
                    if (opt.value === "review") return review()
                    if (opt.value === "pr") return void push("pr")
                    if (opt.value === "push") return void push("only")
                    if (opt.value === "keep") {
                      dialog.clear()
                      props.onDone()
                    }
                    if (opt.value === "discard") setPhase({ type: "confirm" })
                  }}
                  onMouseOver={() => setSelected(i)}
                >
                  <text
                    fg={i === selected() ? theme.primary : opt.value === "discard" ? theme.error : theme.text}
                    attributes={i === selected() ? TextAttributes.BOLD : undefined}
                  >
                    {i === selected() ? "❯ " : "  "}
                    {opt.title}
                  </text>
                </box>
              ))}
            </box>
          </Show>
        </Match>

        <Match when={phase().type === "review"}>
          <box gap={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              Changes
            </text>
            <text fg={theme.text}>{(phase() as { type: "review"; output: string }).output}</text>
            <text fg={theme.textMuted}>press enter or esc to go back</text>
          </box>
        </Match>

        <Match when={phase().type === "pushed"}>
          <box gap={1}>
            <text fg={theme.success} attributes={TextAttributes.BOLD}>
              Pushed
            </text>
            <text fg={theme.text}>{(phase() as { type: "pushed"; output: string }).output}</text>
            <text fg={theme.textMuted}>press enter or esc to go back</text>
          </box>
        </Match>

        <Match when={phase().type === "confirm"}>
          <box gap={1}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              Confirm Discard
            </text>
            <text fg={theme.warning}>
              Press y to permanently discard {changes()} uncommitted changes and {unpushed()} unpushed commits
            </text>
            <text fg={theme.textMuted}>any other key to cancel</text>
          </box>
        </Match>
      </Switch>

      <Show when={err()}>
        <text fg={theme.error}>{err()}</text>
      </Show>
    </box>
  )
}

function extractRemote(output: string, branch: string): string | undefined {
  const match = output.match(/https?:\/\/\S+/)
  if (match) return match[0]
  const remote = output.match(/remote:\s*(https?:\/\/\S+)/)
  if (remote) return remote[1]
  return undefined
}
