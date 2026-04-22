export const EVAL_CONFIG = {
  judgeModel: "claude-haiku-4-5-20251001",
  datasetBuilderModel: "claude-haiku-4-5-20251001",
  concurrency: 5,
  judgeMaxTokens: 10,
  judgeTemperature: 0,
  judgeTimeoutMs: 8_000,
  builderTimeoutMs: 15_000,
  topK: 5,
  maxQueriesPerNote: 2,
  maxAbstentionQueries: 10,
  backoffMs: [1_000, 2_000, 4_000, 8_000],
} as const

export type EvalCategory =
  | "fact-recall"
  | "decision-lookup"
  | "gotcha-recall"
  | "file-context"
  | "convention"
  | "abstention"

export interface DatasetEntry {
  id: string
  category: EvalCategory
  query: string
  goldPaths: string[]
  expectedAbstain: boolean
  sourceNotePath?: string
}

export interface EvalResult {
  id: string
  category: EvalCategory
  query: string
  goldPaths: string[]
  retrievedPaths: string[]
  retrievedScores: number[]
  retrievalMs: number
  judgeMs: number
  judgeLabel: boolean
  judgeReason?: string
  p1: boolean
  p5: boolean
  mrr: number
}
