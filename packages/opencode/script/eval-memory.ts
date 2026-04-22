#!/usr/bin/env bun
import { promises as fs } from "fs"
import path from "path"
import { detectScope } from "../src/plugin/obsidian-memory/scope"
import { buildDataset } from "../src/plugin/obsidian-memory/eval/dataset-builder"
import { runSuite } from "../src/plugin/obsidian-memory/eval/runner"
import { aggregate } from "../src/plugin/obsidian-memory/eval/metrics"
import { readBaseline, writeObsidianReport } from "../src/plugin/obsidian-memory/eval/report"
import { EVAL_CONFIG } from "../src/plugin/obsidian-memory/eval/config"

interface CliArgs {
  vault: string
  worktree: string
  rebuild: boolean
  concurrency: number
  topK: number
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag)
    return idx >= 0 ? args[idx + 1] ?? fallback : fallback
  }
  return {
    vault: get("--vault", process.env.OBSIDIAN_MEMORY_VAULT ?? path.join(process.env.HOME ?? "", "Obsidian/dev-memory")),
    worktree: get("--worktree", process.cwd()),
    rebuild: args.includes("--rebuild-dataset"),
    concurrency: Number(get("--concurrency", String(EVAL_CONFIG.concurrency))),
    topK: Number(get("--top-k", String(EVAL_CONFIG.topK))),
  }
}

async function main() {
  const args = parseArgs()
  console.log(`# obsidian-memory eval`)
  console.log(`vault: ${args.vault}`)
  console.log(`worktree: ${args.worktree}`)
  console.log(`concurrency: ${args.concurrency}, top-k: ${args.topK}`)

  const scope = await detectScope({ worktree: args.worktree, vaultPath: args.vault })
  if (!scope) {
    console.error(`no scope resolved — vault=${args.vault}, worktree=${args.worktree}`)
    process.exit(1)
  }
  const scopeLabel = `${scope.repoSlug}::${scope.branchSlug}`
  console.log(`scope: ${scopeLabel}`)

  const evalDir = path.join(scope.vaultRoot, "_eval")
  const datasetPath = path.join(evalDir, "dataset.jsonl")
  const resultsPath = path.join(evalDir, `results-${new Date().toISOString().slice(0, 10)}.jsonl`)

  const datasetExists = await fileExists(datasetPath)
  if (args.rebuild || !datasetExists) {
    console.log(`\n## Building dataset`)
    const started = Date.now()
    const built = await buildDataset(scope, datasetPath, {
      maxQueriesPerNote: EVAL_CONFIG.maxQueriesPerNote,
      maxAbstention: EVAL_CONFIG.maxAbstentionQueries,
      concurrency: args.concurrency,
    })
    console.log(`built ${built.total} queries in ${Date.now() - started}ms`)
    console.log(`by category: ${JSON.stringify(built.byCategory)}`)
  } else {
    console.log(`\nreusing existing dataset at ${datasetPath} (pass --rebuild-dataset to regenerate)`)
  }

  console.log(`\n## Running suite`)
  const runStarted = Date.now()
  const results = await runSuite(scope, datasetPath, resultsPath, {
    concurrency: args.concurrency,
    topK: args.topK,
  })
  console.log(`ran ${results.length} queries in ${Date.now() - runStarted}ms`)

  const report = aggregate(results)
  const baseline = await readBaseline(scope.vaultRoot)

  const reportPath = await writeObsidianReport(scope.vaultRoot, report, baseline, {
    datasetPath: path.relative(scope.vaultRoot, datasetPath),
    resultsPath: path.relative(scope.vaultRoot, resultsPath),
    scope: scopeLabel,
    judgeModel: EVAL_CONFIG.judgeModel,
  })

  console.log(`\n## Summary`)
  console.log(
    `overall: P@1=${report.overall.p1.toFixed(2)} P@5=${report.overall.p5.toFixed(2)} MRR=${report.overall.mrr.toFixed(3)} accuracy=${(report.overall.accuracy * 100).toFixed(1)}%`,
  )
  console.log(`report: ${reportPath}`)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
