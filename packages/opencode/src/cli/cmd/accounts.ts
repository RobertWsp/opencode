import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { Instance } from "../../project/instance"
import { Provider } from "../../provider/provider"
import { modify, applyEdits } from "jsonc-parser"
import { Filesystem } from "../../util/filesystem"
import path from "path"

function mask(key: string) {
  if (key.length > 4) return "..." + key.slice(-4)
  return "****"
}

async function resolveConfigPath(dir: string) {
  const candidates = [
    path.join(dir, "opencode.json"),
    path.join(dir, "opencode.jsonc"),
    path.join(dir, ".opencode", "opencode.json"),
    path.join(dir, ".opencode", "opencode.jsonc"),
  ]
  for (const c of candidates) {
    if (await Filesystem.exists(c)) return c
  }
  return candidates[0]
}

export const AccountsCommand = cmd({
  command: "accounts",
  describe: "manage account pool for multi-key rotation",
  builder: (yargs) =>
    yargs
      .command(AccountsListCommand)
      .command(AccountsStatusCommand)
      .command(AccountsAddCommand)
      .command(AccountsRemoveCommand)
      .command(AccountsSwitchCommand)
      .demandCommand(),
  async handler() {},
})

export const AccountsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all configured accounts",
  builder: (yargs) =>
    yargs.option("provider", {
      describe: "provider ID",
      type: "string",
      default: "anthropic",
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro(`Accounts ${UI.Style.TEXT_DIM}${args.provider}`)

        const pool = await Provider.getPool(args.provider)
        if (!pool) {
          prompts.log.warn("No account pool configured for this provider. Using single API key.")
          prompts.outro("Done")
          return
        }

        const states = pool.states()
        const active = pool.active()

        for (const s of states) {
          const current = s.info.index === active.index ? " ← active" : ""
          const status = s.status !== "active" ? ` (${s.status})` : ""
          prompts.log.info(`${s.info.index}. ${s.info.label} ${UI.Style.TEXT_DIM}${status}${current}`)
        }

        prompts.outro(`${states.length} account(s)`)
      },
    })
  },
})

export const AccountsStatusCommand = cmd({
  command: "status",
  describe: "detailed account pool status with usage stats",
  builder: (yargs) =>
    yargs.option("provider", {
      describe: "provider ID",
      type: "string",
      default: "anthropic",
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro(`Account Status ${UI.Style.TEXT_DIM}${args.provider}`)

        const pool = await Provider.getPool(args.provider)
        if (!pool) {
          prompts.log.warn("No account pool configured for this provider. Using single API key.")
          prompts.outro("Done")
          return
        }

        const config = await Config.get()
        const accounts = config.provider?.[args.provider]?.options?.accounts
        const states = pool.states()
        const stats = pool.stats()
        const active = pool.active()

        for (const s of states) {
          const key = accounts?.[s.info.index]?.key
          const masked = key ? mask(key) : "n/a"
          const current = s.info.index === active.index ? " ← active" : ""
          const cooldown =
            s.status === "cooldown" && s.cooldownUntil ? ` until ${new Date(s.cooldownUntil).toLocaleTimeString()}` : ""
          prompts.log.info(
            [
              `${s.info.index}. ${s.info.label} ${UI.Style.TEXT_DIM}${masked}${current}`,
              `   status: ${s.status}${cooldown}`,
              `   requests: ${s.requestCount}  tokens: ${s.tokenCount}  switches: ${s.switchCount}`,
            ].join("\n"),
          )
        }

        prompts.log.step(
          [
            `Total requests: ${stats.totalRequests}`,
            `Total switches: ${stats.totalSwitches}`,
            `Active accounts: ${stats.activeCount}/${stats.accountCount}`,
          ].join("  |  "),
        )

        prompts.outro("Done")
      },
    })
  },
})

export const AccountsAddCommand = cmd({
  command: "add <key>",
  describe: "add an account to the pool",
  builder: (yargs) =>
    yargs
      .positional("key", {
        describe: "API key",
        type: "string",
        demandOption: true,
      })
      .option("label", {
        describe: "human-readable label",
        type: "string",
      })
      .option("provider", {
        describe: "provider ID",
        type: "string",
        default: "anthropic",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro(`Add Account ${UI.Style.TEXT_DIM}${args.provider}`)

        const configPath = await resolveConfigPath(Instance.worktree)
        let text = "{}"
        if (await Filesystem.exists(configPath)) {
          text = await Filesystem.readText(configPath)
        }

        const config = await Config.get()
        const existing = config.provider?.[args.provider]?.options?.accounts ?? []
        const entry: { key: string; label?: string } = { key: args.key }
        if (args.label) entry.label = args.label
        const updated = [...existing, entry]

        const edits = modify(text, ["provider", args.provider, "options", "accounts"], updated, {
          formattingOptions: { tabSize: 2, insertSpaces: true },
        })
        const result = applyEdits(text, edits)
        await Filesystem.write(configPath, result)

        const label = args.label ?? `Account #${updated.length}`
        prompts.log.success(`Added ${label} ${UI.Style.TEXT_DIM}${mask(args.key)}`)
        prompts.outro(`${updated.length} account(s) configured in ${configPath}`)
      },
    })
  },
})

export const AccountsRemoveCommand = cmd({
  command: "remove <target>",
  describe: "remove an account by index or label",
  builder: (yargs) =>
    yargs
      .positional("target", {
        describe: "account index (number) or label (string)",
        type: "string",
        demandOption: true,
      })
      .option("provider", {
        describe: "provider ID",
        type: "string",
        default: "anthropic",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro(`Remove Account ${UI.Style.TEXT_DIM}${args.provider}`)

        const config = await Config.get()
        const existing = config.provider?.[args.provider]?.options?.accounts ?? []

        if (existing.length <= 1) {
          prompts.log.error("Cannot remove the last account")
          prompts.outro("Done")
          return
        }

        const idx = /^\d+$/.test(args.target)
          ? parseInt(args.target, 10)
          : existing.findIndex((a) => a.label === args.target)

        if (idx < 0 || idx >= existing.length) {
          prompts.log.error(`Account not found: ${args.target}`)
          prompts.outro("Done")
          return
        }

        const removed = existing[idx]
        const updated = existing.filter((_, i) => i !== idx)

        const configPath = await resolveConfigPath(Instance.worktree)
        let text = "{}"
        if (await Filesystem.exists(configPath)) {
          text = await Filesystem.readText(configPath)
        }

        const edits = modify(text, ["provider", args.provider, "options", "accounts"], updated, {
          formattingOptions: { tabSize: 2, insertSpaces: true },
        })
        const result = applyEdits(text, edits)
        await Filesystem.write(configPath, result)

        const label = removed.label ?? `Account #${idx + 1}`
        prompts.log.success(`Removed ${label} ${UI.Style.TEXT_DIM}${mask(removed.key)}`)
        prompts.outro(`${updated.length} account(s) remaining`)
      },
    })
  },
})

export const AccountsSwitchCommand = cmd({
  command: "switch <target>",
  describe: "switch active account by index or label",
  builder: (yargs) =>
    yargs
      .positional("target", {
        describe: "account index (number) or label (string)",
        type: "string",
        demandOption: true,
      })
      .option("provider", {
        describe: "provider ID",
        type: "string",
        default: "anthropic",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro(`Switch Account ${UI.Style.TEXT_DIM}${args.provider}`)

        const pool = await Provider.getPool(args.provider)
        if (!pool) {
          prompts.log.error("No account pool configured for this provider")
          prompts.outro("Done")
          return
        }

        const states = pool.states()
        const idx = /^\d+$/.test(args.target)
          ? parseInt(args.target, 10)
          : states.findIndex((s) => s.info.label === args.target)

        if (idx < 0 || idx >= states.length) {
          prompts.log.error(`Account not found: ${args.target}`)
          prompts.outro("Done")
          return
        }

        await Provider.switchAccount(args.provider, idx)
        const info = pool.active()
        prompts.log.success(`Switched to ${info.label} (index ${info.index})`)
        prompts.outro("Done")
      },
    })
  },
})
