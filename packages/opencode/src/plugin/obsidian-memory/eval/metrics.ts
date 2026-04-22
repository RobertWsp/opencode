import type { EvalCategory, EvalResult } from "./config"

export interface CategoryMetrics {
  count: number
  p1: number
  p5: number
  mrr: number
  accuracy: number
  retrievalP50: number
  retrievalP95: number
  judgeP50: number
}

export interface AggregateReport {
  generatedAt: string
  total: number
  byCategory: Record<string, CategoryMetrics>
  overall: CategoryMetrics
}

export function aggregate(results: EvalResult[]): AggregateReport {
  const buckets = new Map<string, EvalResult[]>()
  for (const r of results) {
    const arr = buckets.get(r.category) ?? []
    arr.push(r)
    buckets.set(r.category, arr)
  }
  const byCategory: Record<string, CategoryMetrics> = {}
  for (const [cat, rows] of buckets) byCategory[cat] = computeMetrics(rows)
  return {
    generatedAt: new Date().toISOString(),
    total: results.length,
    byCategory,
    overall: computeMetrics(results),
  }
}

function computeMetrics(rows: EvalResult[]): CategoryMetrics {
  const n = rows.length
  if (n === 0) {
    return { count: 0, p1: 0, p5: 0, mrr: 0, accuracy: 0, retrievalP50: 0, retrievalP95: 0, judgeP50: 0 }
  }
  const p1 = rows.filter((r) => r.p1).length / n
  const p5 = rows.filter((r) => r.p5).length / n
  const mrr = rows.reduce((s, r) => s + r.mrr, 0) / n
  const accuracy = rows.filter((r) => r.judgeLabel).length / n
  const retrievalLats = rows.map((r) => r.retrievalMs).sort((a, b) => a - b)
  const judgeLats = rows.map((r) => r.judgeMs).sort((a, b) => a - b)
  return {
    count: n,
    p1,
    p5,
    mrr,
    accuracy,
    retrievalP50: percentile(retrievalLats, 0.5),
    retrievalP95: percentile(retrievalLats, 0.95),
    judgeP50: percentile(judgeLats, 0.5),
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx] ?? 0
}

export function diffReports(current: AggregateReport, baseline: AggregateReport | null): string {
  if (!baseline) return "(no baseline — this is the first run)"
  const lines: string[] = []
  const accDelta = current.overall.accuracy - baseline.overall.accuracy
  const p5Delta = current.overall.p5 - baseline.overall.p5
  lines.push(`Overall accuracy: ${fmtDelta(accDelta)}`)
  lines.push(`Overall P@5: ${fmtDelta(p5Delta)}`)
  const cats = new Set([...Object.keys(current.byCategory), ...Object.keys(baseline.byCategory)])
  for (const cat of cats) {
    const cur = current.byCategory[cat]
    const base = baseline.byCategory[cat]
    if (!cur || !base) continue
    const d = cur.accuracy - base.accuracy
    if (Math.abs(d) > 0.03) lines.push(`  ${cat}: ${fmtDelta(d)}${d < -0.03 ? " ⚠️ regression" : ""}`)
  }
  return lines.join("\n")
}

function fmtDelta(d: number): string {
  const pctVal = d * 100
  const pct = pctVal.toFixed(1)
  const arrow = d > 0.01 ? "↑" : d < -0.01 ? "↓" : "→"
  const sign = pctVal > 0 ? "+" : ""
  return `${arrow} ${sign}${pct}%`
}

export { percentile as _percentile }
