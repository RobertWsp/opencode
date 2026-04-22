import { promises as fs } from "fs"
import path from "path"
import type { AggregateReport, CategoryMetrics } from "./metrics"
import { diffReports } from "./metrics"

export async function writeObsidianReport(
  vaultRoot: string,
  report: AggregateReport,
  baseline: AggregateReport | null,
  extras: { datasetPath: string; resultsPath: string; scope: string; judgeModel: string },
): Promise<string> {
  const dir = path.join(vaultRoot, "_eval")
  await fs.mkdir(dir, { recursive: true })
  const date = report.generatedAt.slice(0, 10)
  const filepath = path.join(dir, `REPORT-${date}.md`)
  const body = renderMarkdown(report, baseline, extras)
  await fs.writeFile(filepath, body, "utf8")
  await fs.writeFile(path.join(dir, "LATEST.md"), body, "utf8")
  await fs.writeFile(path.join(dir, ".last-report.json"), JSON.stringify(report, null, 2), "utf8")
  return filepath
}

export async function readBaseline(vaultRoot: string): Promise<AggregateReport | null> {
  const filepath = path.join(vaultRoot, "_eval", ".last-report.json")
  try {
    const raw = await fs.readFile(filepath, "utf8")
    return JSON.parse(raw) as AggregateReport
  } catch {
    return null
  }
}

function renderMarkdown(
  report: AggregateReport,
  baseline: AggregateReport | null,
  extras: { datasetPath: string; resultsPath: string; scope: string; judgeModel: string },
): string {
  const lines: string[] = []
  lines.push(`---`)
  lines.push(`generated: ${report.generatedAt}`)
  lines.push(`scope: ${extras.scope}`)
  lines.push(`judge-model: ${extras.judgeModel}`)
  lines.push(`total-queries: ${report.total}`)
  lines.push(`tags: eval, obsidian-memory`)
  lines.push(`---`)
  lines.push(``)
  lines.push(`# Memory Eval Report — ${report.generatedAt.slice(0, 10)}`)
  lines.push(``)
  lines.push(`**Scope**: \`${extras.scope}\`  `)
  lines.push(`**Dataset**: \`${extras.datasetPath}\`  `)
  lines.push(`**Results**: \`${extras.resultsPath}\`  `)
  lines.push(`**Judge**: \`${extras.judgeModel}\`  `)
  lines.push(``)
  lines.push(`## Overall`)
  lines.push(``)
  lines.push(renderRow("overall", report.overall))
  lines.push(``)
  lines.push(`## By category`)
  lines.push(``)
  lines.push(`| Category | Count | P@1 | P@5 | MRR | Accuracy | Retrieval p50 | p95 | Judge p50 |`)
  lines.push(`|----------|-------|-----|-----|-----|----------|---------------|-----|-----------|`)
  for (const [cat, m] of Object.entries(report.byCategory)) {
    lines.push(renderRow(cat, m))
  }
  lines.push(``)
  lines.push(`## Delta vs baseline`)
  lines.push(``)
  lines.push("```")
  lines.push(diffReports(report, baseline))
  lines.push("```")
  lines.push(``)
  lines.push(`## Notes`)
  lines.push(``)
  lines.push(`- Baseline is the previous run stored in \`_eval/.last-report.json\`.`)
  lines.push(`- Judge grades each retrieval binary (yes/no) with temperature=0.`)
  lines.push(`- Abstention: P@1/P@5/MRR use "no results returned" as success signal.`)
  lines.push(`- Re-run with \`bun run script/eval-memory.ts\`.`)
  return lines.join("\n") + "\n"
}

function renderRow(name: string, m: CategoryMetrics): string {
  return `| ${name} | ${m.count} | ${m.p1.toFixed(2)} | ${m.p5.toFixed(2)} | ${m.mrr.toFixed(3)} | ${(m.accuracy * 100).toFixed(1)}% | ${m.retrievalP50}ms | ${m.retrievalP95}ms | ${m.judgeP50}ms |`
}
