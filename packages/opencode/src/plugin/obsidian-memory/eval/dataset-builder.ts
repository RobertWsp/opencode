import { promises as fs } from "fs"
import path from "path"
import { callHaiku } from "../haiku-client"
import { loadAllEntries } from "../candidate-retrieval"
import type { Scope, MemoryEntry } from "../types"
import { Log } from "../../../util/log"
import { EVAL_CONFIG, type DatasetEntry, type EvalCategory } from "./config"

const log = Log.create({ service: "obsidian-memory.eval.builder" })

const BUILDER_SYSTEM = `You generate developer evaluation queries from a single memory note.

Given a note's title, kind, tags, and body, output a JSON array of 1-2 questions a developer might ask whose answer is found in THIS note.

Rules:
- Questions must be in the same language as the note (pt-br or en).
- Keep questions natural and specific — not generic ("what is this?").
- Vary phrasing: some direct, some indirect.
- Prefer questions that would match this note's content uniquely over generic vault-wide topics.
- Output valid JSON only: [{"query":"...","category":"fact-recall|decision-lookup|gotcha-recall|file-context|convention"}]
- Pick the category that best matches the note's kind:
  - fact: fact-recall
  - decision: decision-lookup
  - gotcha/error/bug: gotcha-recall
  - convention/pattern/style: convention
  - skill/procedure/howto: fact-recall
  - episode/session/timeline: decision-lookup
  - If note references specific files: file-context (only if question is about those files).
- No explanation. No markdown. No backticks. Just a JSON array.`

const ABSTENTION_QUERIES: string[] = [
  "qual o salário médio da equipe de engenharia?",
  "quais são as tarefas prioritárias do sprint de Q1 2024?",
  "how do I deploy to the staging environment in legacy-erp?",
  "qual a senha do banco de produção do projeto X?",
  "o que foi discutido na reunião do dia 5 de janeiro?",
  "como configurar OAuth2 no frontend Angular do cliente Y?",
  "what's the approved Dockerfile template for Node microservices?",
  "qual é o processo de onboarding de novos desenvolvedores?",
  "list the feature flags enabled in production right now",
  "what decisions did the architecture committee make last quarter?",
]

export async function buildDataset(
  scope: Scope,
  outputPath: string,
  options: { maxQueriesPerNote?: number; maxAbstention?: number; concurrency?: number } = {},
): Promise<{ total: number; byCategory: Record<string, number> }> {
  const maxQ = options.maxQueriesPerNote ?? EVAL_CONFIG.maxQueriesPerNote
  const maxAbs = options.maxAbstention ?? EVAL_CONFIG.maxAbstentionQueries
  const concurrency = options.concurrency ?? EVAL_CONFIG.concurrency

  const entries = await loadAllEntries(scope)
  log.info("builder loaded entries", { count: entries.length, scope: scope.repoSlug })

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, "")

  let idCounter = 0
  const byCategory: Record<string, number> = {}
  const countBy = (c: string) => (byCategory[c] = (byCategory[c] ?? 0) + 1)

  const pending: MemoryEntry[] = [...entries]
  const workers: Promise<void>[] = []

  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (pending.length > 0) {
          const entry = pending.shift()
          if (!entry) break
          const queries = await generateForEntry(entry, maxQ)
          for (const q of queries) {
            idCounter++
            const row: DatasetEntry = {
              id: `q${String(idCounter).padStart(4, "0")}`,
              category: q.category,
              query: q.query,
              goldPaths: [entry.doc.path],
              expectedAbstain: false,
              sourceNotePath: entry.doc.path,
            }
            await fs.appendFile(outputPath, JSON.stringify(row) + "\n")
            countBy(q.category)
          }
        }
      })(),
    )
  }

  await Promise.all(workers)

  for (const q of ABSTENTION_QUERIES.slice(0, maxAbs)) {
    idCounter++
    const row: DatasetEntry = {
      id: `q${String(idCounter).padStart(4, "0")}`,
      category: "abstention",
      query: q,
      goldPaths: [],
      expectedAbstain: true,
    }
    await fs.appendFile(outputPath, JSON.stringify(row) + "\n")
    countBy("abstention")
  }

  log.info("builder complete", { total: idCounter, byCategory })
  return { total: idCounter, byCategory }
}

async function generateForEntry(
  entry: MemoryEntry,
  maxQ: number,
): Promise<Array<{ query: string; category: EvalCategory }>> {
  const tags = (entry.doc.meta["tags"] ?? "").split(",").filter(Boolean).slice(0, 8)
  const body = entry.doc.body.slice(0, 1500)
  const userMessage = [
    `title: ${entry.title}`,
    `kind: ${entry.kind}`,
    `tags: ${tags.join(", ")}`,
    `importance: ${entry.importance}`,
    `body:`,
    body,
  ].join("\n")

  const result = await callHaiku({
    model: EVAL_CONFIG.datasetBuilderModel,
    systemPrompt: BUILDER_SYSTEM,
    userMessage,
    maxTokens: 300,
    timeoutMs: EVAL_CONFIG.builderTimeoutMs,
  })

  if (!result.ok || !result.text) {
    log.warn("builder call failed", { path: entry.doc.path, error: result.error })
    return []
  }

  const raw = result.text.trim()
  const first = raw.indexOf("[")
  const last = raw.lastIndexOf("]")
  if (first < 0 || last <= first) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw.slice(first, last + 1))
  } catch {
    log.warn("builder produced invalid JSON", { path: entry.doc.path, snippet: raw.slice(0, 120) })
    return []
  }
  if (!Array.isArray(arr)) return []

  const out: Array<{ query: string; category: EvalCategory }> = []
  for (const item of arr.slice(0, maxQ)) {
    const obj = item as { query?: unknown; category?: unknown }
    const query = typeof obj.query === "string" ? obj.query.trim() : ""
    const category = typeof obj.category === "string" ? obj.category.trim() : ""
    if (!query || !isValidCategory(category)) continue
    out.push({ query, category: category as EvalCategory })
  }
  return out
}

function isValidCategory(c: string): boolean {
  return ["fact-recall", "decision-lookup", "gotcha-recall", "file-context", "convention"].includes(c)
}
