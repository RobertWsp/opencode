import { promises as fs } from "fs"
import crypto from "crypto"
import path from "path"
import ignore from "ignore"
import type { Database } from "bun:sqlite"
import { getParser } from "./parsers"
import { extract } from "./extractor"
import { getFileHash, deleteFileGraph, storeFileBatch } from "./db"
import type { CodeGraphConfig } from "./config"
import { Log } from "../../util/log"

const log = Log.create({ service: "plugin.code-graph.ingest" })

export interface IngestStats {
  added: number
  updated: number
  skipped: number
  failed: number
}

const EXT_LANG: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
}

function sha(content: string) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)
}

async function* scan(root: string, ig: ReturnType<typeof ignore>, langs: string[], maxBytes: number) {
  const g = new Bun.Glob("**/*")
  for await (const rel of g.scan({ cwd: root, dot: true })) {
    const lang = EXT_LANG[path.extname(rel)]
    if (!lang || !langs.includes(lang)) continue
    if (ig.ignores(rel)) continue
    const abs = path.join(root, rel)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat?.isFile() || stat.size > maxBytes) continue
    yield { abs, lang }
  }
}

export async function ingestFile(db: Database, filePath: string, lang: string, maxBytes = 524288): Promise<keyof IngestStats> {
  const content = await fs.readFile(filePath, "utf8").catch(() => null)
  if (!content || Buffer.byteLength(content) > maxBytes) return "failed"

  const h = sha(content)
  const stored = getFileHash(db, filePath)
  if (stored === h) return "skipped"

  const parser = await getParser(lang)
  if (!parser) {
    log.warn("no-parser", { lang, filePath })
    return "failed"
  }

  const tree = parser.parse(content)
  if (!tree) return "failed"

  const { nodes, edges } = extract(tree, filePath, h, lang)
  deleteFileGraph(db, filePath)
  try {
    storeFileBatch(db, filePath, h, lang, nodes, edges)
  } catch (err: unknown) {
    log.warn("store-failed", { filePath, err: String(err) })
    return "failed"
  }

  return stored ? "updated" : "added"
}

export async function ingestDir(db: Database, root: string, cfg: CodeGraphConfig): Promise<IngestStats> {
  const ig = ignore().add(cfg.ignore)
  const stats: IngestStats = { added: 0, updated: 0, skipped: 0, failed: 0 }
  for await (const { abs, lang } of scan(root, ig, cfg.languages, cfg.maxFileBytes)) {
    const r = await ingestFile(db, abs, lang, cfg.maxFileBytes)
    stats[r]++
  }
  return stats
}
