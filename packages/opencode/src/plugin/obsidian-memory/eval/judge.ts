import { callHaiku } from "../haiku-client"
import { Log } from "../../../util/log"
import { EVAL_CONFIG } from "./config"

const log = Log.create({ service: "obsidian-memory.eval.judge" })

export interface JudgeInput {
  query: string
  goldPaths: string[]
  retrievedSnippets: Array<{ path: string; title: string; score: number; snippet: string }>
  expectedAbstain: boolean
}

export interface JudgeOutput {
  label: boolean
  reason: string
  durationMs: number
}

const RETRIEVAL_JUDGE_SYSTEM = `You are a strict but fair memory-retrieval evaluator. Given a developer query, a list of gold-standard memory file paths, and the retrieved snippets from a vault search, decide if the retrieval is USEFUL for answering the query.

CORRECT if ANY of:
- A gold path appears in the retrieved paths (top-5).
- A retrieved snippet clearly covers the same topic as the gold memory, even if the path differs.
- The retrieval brings back on-topic developer context that would materially help answering the query.

WRONG if:
- Retrieved snippets are all off-topic OR no snippets returned when gold exists.
- Top-ranked snippets would mislead (unrelated content ranked highest).

Be generous on topical match — partial relevance counts as CORRECT. Output exactly one word: yes or no.`

const ABSTENTION_JUDGE_SYSTEM = `You are a pragmatic memory-retrieval evaluator for ABSTENTION queries — queries whose answer is NOT in the vault.

A retrieval is CORRECT on abstention queries whenever a downstream agent reading ONLY the top-5 snippets would NOT be misled into fabricating a confident answer to the query.

CORRECT (output "yes") if ANY of:
- No snippets returned at all.
- Retrieved snippets are on tangential/adjacent topics but do not actually contain an answer to the specific query (a downstream model would still say "not enough info").
- Top snippet scores are modest/low (< 0.5) — scoring already signals low confidence.
- Snippets are about unrelated entities/topics that a reasonable agent would clearly recognize as non-matches.

WRONG (output "no") ONLY if:
- A retrieved snippet would plausibly let a downstream agent fabricate a confident WRONG answer (e.g. user asks about salary, a snippet contains a fake salary-looking number).
- Top-1 is high-score AND topically misleading in a way that directly impersonates the requested answer.

Be GENEROUS. The vault scoping means many abstention queries pull loosely-related project notes — that's fine as long as they do not masquerade as answers. Only mark WRONG on clearly deceptive top results.

Output exactly one word: yes or no.`

export async function judgeRetrieval(input: JudgeInput): Promise<JudgeOutput> {
  const started = Date.now()

  // Hard auto-pass for abstention when all scores < 0.5 — prompt already encodes this rule
  // but LLM flakiness can cause false "no". Enforce deterministically.
  if (input.expectedAbstain && input.retrievedSnippets.length > 0) {
    const max = Math.max(...input.retrievedSnippets.map((s) => s.score))
    if (max < 0.5) return { label: true, reason: "auto-pass: max-score<0.5", durationMs: Date.now() - started }
  }

  const system = input.expectedAbstain ? ABSTENTION_JUDGE_SYSTEM : RETRIEVAL_JUDGE_SYSTEM

  const snippetsBlock = input.retrievedSnippets.length
    ? input.retrievedSnippets
        .map(
          (s, i) =>
            `[${i + 1}] path=${s.path} title="${s.title}" score=${s.score.toFixed(3)}\n    ${s.snippet.slice(0, 200).replace(/\n/g, " ")}`,
        )
        .join("\n")
    : "(no results returned)"

  const userMessage = [
    `Query: ${input.query}`,
    "",
    `Gold memory paths: ${input.goldPaths.length ? input.goldPaths.join(", ") : "(none — this is an abstention query)"}`,
    "",
    `Retrieved snippets (top ${input.retrievedSnippets.length}):`,
    snippetsBlock,
    "",
    "Answer yes or no only.",
  ].join("\n")

  const result = await callHaikuWithBackoff({
    model: EVAL_CONFIG.judgeModel,
    systemPrompt: system,
    userMessage,
    maxTokens: EVAL_CONFIG.judgeMaxTokens,
    timeoutMs: EVAL_CONFIG.judgeTimeoutMs,
  })

  const durationMs = Date.now() - started

  if (!result.ok || !result.text) {
    log.warn("judge call failed", { error: result.error, durationMs })
    return { label: false, reason: `judge-error: ${result.error ?? "unknown"}`, durationMs }
  }

  const raw = result.text.trim().toLowerCase()
  const label = /^\s*yes\b/.test(raw) || /\byes\b/.test(raw.split("\n")[0] ?? "")
  return { label, reason: raw.slice(0, 80), durationMs }
}

async function callHaikuWithBackoff(args: {
  model: string
  systemPrompt: string
  userMessage: string
  maxTokens: number
  timeoutMs: number
}) {
  let lastError = ""
  for (const wait of [0, ...EVAL_CONFIG.backoffMs]) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const r = await callHaiku(args)
    if (r.ok) return r
    lastError = r.error ?? "unknown"
    if (!/429|rate|timeout|ETIMEDOUT|ECONNRESET/i.test(lastError)) return r
  }
  return { ok: false, error: `backoff-exhausted: ${lastError}`, durationMs: 0 }
}
