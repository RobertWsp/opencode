import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../../util/log"

const log = Log.create({ service: "plugin.code-graph" })

export async function CodeGraphPlugin(_input: PluginInput): Promise<Hooks> {
  log.info("loading plugin")
  return {}
}
