import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../../util/log"
import path from "path"
import { ensureDb } from "./db"
import { ingestFile, ingestDir } from "./ingest"
import { parseCodeGraphConfig } from "./config"
import type { Language } from "./types"

const log = Log.create({ service: "plugin.code-graph" })

const LANGS = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs"])

export async function CodeGraphPlugin(input: PluginInput): Promise<Hooks> {
  const cfg = parseCodeGraphConfig(
    (input as unknown as { config?: { code_graph?: unknown } }).config?.code_graph,
  )
  if (!cfg.enabled) return {}

  log.info("loading plugin", { autoBuild: cfg.autoBuild, watch: cfg.watch })

  const root = input.worktree ?? input.directory ?? process.cwd()
  const dbPath = path.isAbsolute(cfg.dbPath) ? cfg.dbPath : path.join(root, cfg.dbPath)

  let _db: Awaited<ReturnType<typeof ensureDb>> | null = null
  const db = async () => {
    if (!_db) _db = await ensureDb(dbPath)
    return _db
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  return {
    async event(payload) {
      const ev = payload.event as { type: string; properties?: Record<string, unknown> }

      if (ev.type === "file.watcher.updated" && cfg.watch) {
        const file = ev.properties?.file as string | undefined
        if (!file) return
        const ext = path.extname(file).slice(1)
        if (!LANGS.has(ext)) return
        if (!cfg.languages.includes(ext)) return

        if (timers.has(file)) clearTimeout(timers.get(file)!)
        timers.set(
          file,
          setTimeout(async () => {
            timers.delete(file)
            try {
              const d = await db()
              const result = await ingestFile(d, file, ext as Language, cfg.maxFileBytes)
              log.info("watchdog re-ingested", { file, result })
            } catch (err) {
              log.error("watchdog re-ingest failed", { file, error: String(err) })
            }
          }, 500),
        )
      }

      if (ev.type === "session.idle" && cfg.autoBuild) {
        try {
          const d = await db()
          const count = (d.query<{ n: number }, []>("SELECT COUNT(*) as n FROM nodes").get() ?? { n: 0 }).n
          if (count === 0) {
            log.info("auto-build triggered on session.idle")
            await ingestDir(d, root, cfg)
            log.info("auto-build complete")
          }
        } catch (err) {
          log.error("auto-build failed", { error: String(err) })
        }
      }
    },
  }
}
