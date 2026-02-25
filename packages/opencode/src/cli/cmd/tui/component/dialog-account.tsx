import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy, flatMap } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2"
import { useKeyboard } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  anthropic: 1,
  "github-copilot": 2,
  openai: 3,
  google: 4,
}

export function DialogAccountAdd() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const options = createMemo(() =>
    pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => ({
        title: provider.name,
        value: provider.id,
        description: {
          opencode: "(Recommended)",
          anthropic: "(Claude Max or API key)",
          openai: "(ChatGPT Plus/Pro or API key)",
        }[provider.id],
        category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Other",
        async onSelect() {
          const entries = await sdk.client.provider.auth2.list({ providerID: provider.id })
          const count = entries.data?.length ?? 0
          const authKey = count === 0 ? `${provider.id}:1` : `${provider.id}:${count}`

          const methods = sync.data.provider_auth[provider.id] ?? [
            {
              type: "api",
              label: "API key",
            },
          ]
          let index: number | null = 0
          if (methods.length > 1) {
            index = await new Promise<number | null>((resolve) => {
              dialog.replace(
                () => (
                  <DialogSelect
                    title="Select auth method"
                    options={methods.map((x, i) => ({
                      title: x.label,
                      value: i,
                    }))}
                    onSelect={(option) => resolve(option.value)}
                  />
                ),
                () => resolve(null),
              )
            })
          }
          if (index == null) return
          const method = methods[index]
          if (method.type === "oauth") {
            const result = await sdk.client.provider.oauth.authorize({
              providerID: provider.id,
              method: index,
              authKey,
            })
            if (result.data?.method === "code") {
              dialog.replace(() => (
                <AccountCodeMethod
                  providerID={provider.id}
                  title={method.label}
                  index={index}
                  authKey={authKey}
                  authorization={result.data!}
                />
              ))
            }
            if (result.data?.method === "auto") {
              dialog.replace(() => (
                <AccountAutoMethod
                  providerID={provider.id}
                  title={method.label}
                  index={index}
                  authKey={authKey}
                  authorization={result.data!}
                />
              ))
            }
          }
          if (method.type === "api") {
            dialog.replace(() => <AccountApiMethod providerID={provider.id} title={method.label} authKey={authKey} />)
          }
        },
      })),
    ),
  )

  return <DialogSelect title="Add account — select provider" options={options()} />
}

interface AccountAutoMethodProps {
  index: number
  providerID: string
  title: string
  authKey: string
  authorization: ProviderAuthAuthorization
}
function AccountAutoMethod(props: AccountAutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
      authKey: props.authKey,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.clear()
    toast.show({
      message: `Account added for ${props.providerID}`,
      variant: "info",
    })
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface AccountCodeMethodProps {
  index: number
  title: string
  providerID: string
  authKey: string
  authorization: ProviderAuthAuthorization
}
function AccountCodeMethod(props: AccountCodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
          authKey: props.authKey,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.clear()
          toast.show({
            message: `Account added for ${props.providerID}`,
            variant: "info",
          })
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface AccountApiMethodProps {
  providerID: string
  title: string
  authKey: string
}
function AccountApiMethod(props: AccountApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.authKey,
          auth: {
            type: "api",
            key: value,
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.clear()
        toast.show({
          message: `Account added for ${props.providerID}`,
          variant: "info",
        })
      }}
    />
  )
}

export function DialogAccountRemove() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [entries, setEntries] = createSignal<
    Array<{
      title: string
      value: { providerID: string; authKey: string }
      category: string
    }>
  >([])

  onMount(async () => {
    const providers = sync.data.provider_next.all
    const results = await Promise.all(
      providers.map(async (p) => {
        const result = await sdk.client.provider.auth2.list({ providerID: p.id })
        return { provider: p, entries: result.data ?? [] }
      }),
    )
    const opts = pipe(
      results,
      flatMap(({ provider, entries }) =>
        entries
          .filter((e) => e.key.includes(":"))
          .map((e) => ({
            title: e.label || e.key,
            value: { providerID: provider.id, authKey: e.key },
            category: provider.name,
          })),
      ),
    )
    setEntries(opts)
  })

  return (
    <DialogSelect
      title="Remove account"
      options={entries()}
      onSelect={async (option) => {
        const result = await sdk.client.provider.accounts2.remove({
          providerID: option.value.providerID,
          authKey: option.value.authKey,
        })
        if (result.error) {
          toast.error(result.error)
          return
        }
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.clear()
        toast.show({
          message: "Account removed",
          variant: "info",
        })
      }}
    />
  )
}
