import { promises as fs } from "fs"
import path from "path"
import { Log } from "../../util/log"
import { loadAllEntries } from "./candidate-retrieval"
import { staleEntries } from "./forgetting"
import type { Scope } from "./types"

const log = Log.create({ service: "plugin.obsidian-memory.gc" })

const DEFAULT_MIN_VAULT_SIZE_FOR_GC = 150
const DEFAULT_RETENTION_DAYS = 90

export interface GcResult {
  scanned: number
  archived: number
  archiveDir: string
}

export async function runGc(
  scope: Scope,
  opts: { minVaultSize?: number; retentionDays?: number } = {},
): Promise<GcResult | null> {
  const minSize = opts.minVaultSize ?? DEFAULT_MIN_VAULT_SIZE_FOR_GC
  const retention = opts.retentionDays ?? DEFAULT_RETENTION_DAYS

  const entries = await loadAllEntries(scope)
  if (entries.length < minSize) {
    log.debug("gc skipped: vault below threshold", { size: entries.length, minSize })
    return null
  }

  const stale = staleEntries(entries, retention)
  if (stale.length === 0) {
    log.info("gc ran: nothing stale to archive", { total: entries.length })
    return { scanned: entries.length, archived: 0, archiveDir: "" }
  }

  const archiveDir = path.join(scope.branchDir, "archive")
  await fs.mkdir(archiveDir, { recursive: true })

  let archived = 0
  for (const e of stale) {
    try {
      const filename = path.basename(e.doc.path)
      const target = path.join(archiveDir, filename)
      await fs.rename(e.doc.path, target)
      archived++
    } catch (err) {
      log.warn("archive failed", { path: e.doc.path, error: String(err) })
    }
  }

  log.info("gc archived stale notes", {
    scanned: entries.length,
    archived,
    archiveDir,
    retentionDays: retention,
  })
  return { scanned: entries.length, archived, archiveDir }
}
