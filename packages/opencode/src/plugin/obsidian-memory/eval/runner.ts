import { promises as fs } from "fs"
import path from "path"
import { hybridRank } from "../retrieval"
import type { Scope } from "../types"
import { Log } from "../../../util/log"
import { EVAL_CONFIG, type DatasetEntry, type EvalResult } from "./config"
import { judgeRetrieval } from "./judge"

const log = Log.create({ service: "obsidian-memory.eval.runner" })

export async function runSuite(
  scope: Scope,
  datasetPath: string,
  outputPath: string,
  opts: { concurrency?: number; topK?: number } = {},
): Promise<EvalResult[]> {
  const concurrency = opts.concurrency ?? EVAL_CONFIG.concurrency
  const topK = opts.topK ?? EVAL_CONFIG.topK

  const raw = await fs.readFile(datasetPath, "utf8")
  const dataset: DatasetEntry[] = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DatasetEntry)

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, "")

  log.info("runner starting", { total: dataset.length, concurrency, topK, scope: scope.repoSlug })

  const results: EvalResult[] = []
  const pending = [...dataset]
  const workers: Promise<void>[] = []

  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (pending.length > 0) {
          const entry = pending.shift()
          if (!entry) break
          const result = await evalOne(scope, entry, topK)
          results.push(result)
          await fs.appendFile(outputPath, JSON.stringify(result) + "\n")
          if (results.length % 10 === 0) {
            log.info("runner progress", {
              done: results.length,
              total: dataset.length,
            })
          }
        }
      })(),
    )
  }

  await Promise.all(workers)
  log.info("runner complete", { total: results.length })
  return results
}

async function evalOne(scope: Scope, entry: DatasetEntry, topK: number): Promise<EvalResult> {
  const retrStart = Date.now()
  let retrieved: Array<{ path: string; title: string; score: number; snippet: string }> = []
  try {
    const ranked = await hybridRank(scope, entry.query, { limit: topK })
    retrieved = ranked.map((r) => ({
      path: r.entry.doc.path,
      title: r.entry.title,
      score: r.score,
      snippet: (r.entry.description || r.entry.doc.body.slice(0, 200)).replace(/\s+/g, " ").slice(0, 240),
    }))
  } catch (err) {
    log.warn("retrieval failed", { id: entry.id, error: String(err) })
  }
  const retrievalMs = Date.now() - retrStart

  const judge = await judgeRetrieval({
    query: entry.query,
    goldPaths: entry.goldPaths,
    retrievedSnippets: retrieved,
    expectedAbstain: entry.expectedAbstain,
  })

  const retrievedPaths = retrieved.map((r) => r.path)
  const goldSet = new Set(entry.goldPaths)
  const firstGoldRank = retrievedPaths.findIndex((p) => goldSet.has(p))
  const p1 = entry.expectedAbstain ? retrieved.length === 0 : firstGoldRank === 0
  const p5 = entry.expectedAbstain ? retrieved.length === 0 : firstGoldRank >= 0 && firstGoldRank < 5
  const mrr = entry.expectedAbstain ? (retrieved.length === 0 ? 1 : 0) : firstGoldRank >= 0 ? 1 / (firstGoldRank + 1) : 0

  return {
    id: entry.id,
    category: entry.category,
    query: entry.query,
    goldPaths: entry.goldPaths,
    retrievedPaths,
    retrievedScores: retrieved.map((r) => r.score),
    retrievalMs,
    judgeMs: judge.durationMs,
    judgeLabel: judge.label,
    judgeReason: judge.reason,
    p1,
    p5,
    mrr,
  }
}
