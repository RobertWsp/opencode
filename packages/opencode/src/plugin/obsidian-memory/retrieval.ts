import { Log } from "../../util/log"
import { rrfMerge } from "./rrf"
import { loadAllEntries, tokenize as candidateTokenize } from "./candidate-retrieval"
import { callHaiku } from "./haiku-client"
import { isValidAt } from "./parse-entry"
import { filterActive } from "./forgetting"
import type { Confidence, MemoryEntry, Scope } from "./types"
import { VaultIndex, getVaultIndex, type FtsHit } from "./vault-index"
import type { VectorStore } from "./vector-store"
import type { Embedder } from "./embedder"

const log = Log.create({ service: "plugin.obsidian-memory.retrieval" })

/**
 * Composed retrieval ranked by:
 *
 *    score = α·recency + β·importance + γ·relevance + δ·pagerank
 *
 * Where:
 * - **recency**: exp(-age_days / half_life). Validates the temporal signal.
 * - **importance**: frontmatter 0-1 from the Haiku gate.
 * - **relevance**: BM25 via FTS5 when available; fallback to token jaccard.
 * - **pagerank**: seeded Personalized PageRank over wikilinks (optional).
 *
 * Coefficients default to (0.25, 0.25, 0.35, 0.15). Validated empirically by
 * Generative Agents (Park et al. 2023) and HippoRAG for the PR contribution.
 *
 * The `query` is either the user's raw prompt or a HyDE-expanded version
 * (see `expandQueryHyde`). The caller decides — both return the same shape.
 */

export interface RetrievalOptions {
  /** Max number of entries to return */
  limit?: number
  /** Override the default weights */
  weights?: Partial<ScoreWeights>
  /** Half-life in days for recency decay */
  recencyHalfLifeDays?: number
  /** Optional PageRank scores by path (for R3.2) */
  pagerankScores?: Map<string, number>
  /** When false, skip FTS5 completely and use candidate-retrieval tokenizer */
  useFts5?: boolean
  /**
   * Files the agent touched in this session (read, edited, created).
   * Memories whose body or refs mention these files get a boost — inspired
   * by Windsurf's "active file gets highest weight" and Copilot's JIT
   * citation verification pattern.
   */
  activeFiles?: Set<string>
}

export interface ScoreWeights {
  recency: number
  importance: number
  relevance: number
  pagerank: number
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  recency: 0.25,
  importance: 0.25,
  relevance: 0.35,
  pagerank: 0.15,
}

export interface RankedEntry {
  entry: MemoryEntry
  score: number
  breakdown: {
    recency: number
    importance: number
    relevance: number
    pagerank: number
    rrf?: number
  }
}

/**
 * Rank all valid memories in the scope by the composed formula. If
 * `query` is empty or whitespace, falls back to recency-only ordering
 * (preserving the V1 behavior as a graceful degradation path).
 */
export async function rankMemories(
  scope: Scope,
  query: string,
  opts: RetrievalOptions = {},
): Promise<RankedEntry[]> {
  const limit = opts.limit ?? 20
  const half = opts.recencyHalfLifeDays ?? 30
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) }
  const useFts = opts.useFts5 !== false

  const allEntries = (await loadAllEntries(scope)).filter((e) => isValidAt(e))
  const entries = filterActive(allEntries)
  if (entries.length === 0) return []

  // Relevance step: run FTS5 (preferred) or fallback to token jaccard
  const relevanceByPath = await computeRelevance(scope, query, entries, useFts)

  // Pre-compute file-match boost: if a memory mentions files the agent is
  // currently touching, it's contextually much more relevant. This implements
  // the "active file boost" pattern from Windsurf/Copilot.
  const activeFileSet = opts.activeFiles
  const FILE_MATCH_BOOST = 1.5 // multiply score by this when files match

  const now = Date.now()
  const ranked: RankedEntry[] = entries.map((entry) => {
    const ageDays = Math.max(0, (now - entry.doc.mtimeMs) / (1000 * 60 * 60 * 24))
    const recency = Math.exp(-ageDays / half)
    const importance = entry.importance
    const relevance = relevanceByPath.get(entry.doc.path) ?? 0
    const pagerank = opts.pagerankScores?.get(entry.doc.path) ?? 0
    let score =
      recency * weights.recency +
      importance * weights.importance +
      relevance * weights.relevance +
      pagerank * weights.pagerank

    // File-aware boost: check if memory body/refs reference any actively-touched file
    if (activeFileSet && activeFileSet.size > 0) {
      const bodyAndRefs = entry.doc.body + " " + (entry.doc.meta["refs"] ?? "")
      for (const file of activeFileSet) {
        // Match by basename or partial path (e.g. "auth.ts" matches "/src/auth.ts")
        const basename = file.split("/").pop() ?? file
        if (bodyAndRefs.includes(basename) || bodyAndRefs.includes(file)) {
          score *= FILE_MATCH_BOOST
          break
        }
      }
    }

    return {
      entry,
      score,
      breakdown: { recency, importance, relevance, pagerank },
    }
  })

  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, limit)
}

/**
 * Compute relevance scores in [0, 1] for each entry against the query.
 * Primary path: SQLite FTS5 BM25 (fast, accurate on identifiers/paths).
 * Fallback: token Jaccard vs the same candidate-retrieval tokenizer.
 */
async function computeRelevance(
  scope: Scope,
  query: string,
  entries: MemoryEntry[],
  useFts: boolean,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!query.trim()) return out

  if (useFts) {
    try {
      const index = getVaultIndex(scope.vaultRoot)
      // Lazy rebuild if index is empty OR if filesystem has more files
      // than indexed (external edits, new auto-captures not yet upserted).
      if (entries.length > 0 && (index.count() === 0 || (await index.isStale(scope)))) {
        await index.rebuild(scope)
      }
      const hits = index.search(query, Math.max(entries.length, 50))
      if (hits.length > 0) {
        const maxAbs = Math.max(1, ...hits.map((h) => Math.abs(h.score)))
        for (const hit of hits) {
          // Normalize BM25 score to [0, 1] by dividing by max absolute.
          // BM25 already produces higher=better in our inverted shape.
          out.set(hit.memory.path, Math.min(1, Math.max(0, hit.score / maxAbs)))
        }
        return out
      }
    } catch (err) {
      log.debug("FTS5 relevance failed, falling back to Jaccard", { error: String(err) })
    }
  }

  // Fallback: token jaccard
  const queryTokens = candidateTokenize(query)
  if (queryTokens.size === 0) return out
  for (const entry of entries) {
    const entryTokens = candidateTokenize(
      `${entry.title} ${entry.description} ${entry.doc.body}`,
    )
    let inter = 0
    for (const t of queryTokens) if (entryTokens.has(t)) inter++
    const union = queryTokens.size + entryTokens.size - inter
    const jaccard = union === 0 ? 0 : inter / union
    if (jaccard > 0) out.set(entry.doc.path, jaccard)
  }
  return out
}

// ─── HyDE query expansion ──────────────────────────────────────────

const HYDE_SYSTEM_PROMPT = `You are a query expansion assistant for a coding agent's memory system.

Given the user's latest prompt, generate a SHORT hypothetical memory document
(5-10 lines) that would be the ideal match if it existed in the vault. Use the
vocabulary a developer would use in a technical note: type names, file paths,
error messages, library names. Do NOT answer the user — your output is only
used as a retrieval probe.

Output plain text, no JSON, no markdown fences, just the hypothetical note.`

interface HydeCacheEntry {
  expansion: string
  ts: number
}

const HYDE_CACHE_TTL_MS = 5 * 60 * 1000 // 5min
const hydeCache = new Map<string, HydeCacheEntry>()

/**
 * Expand a raw user prompt into a hypothetical answer document for HyDE
 * retrieval. Returns the original prompt on error. Caches by prompt hash
 * for 5 minutes to avoid re-paying for repeated retrievals in a session.
 *
 * Cost: ~$0.0001 per call (Haiku, ~200 output tokens).
 */
export async function expandQueryHyde(
  userPrompt: string,
  model: string,
  timeoutMs = 8000,
): Promise<string> {
  const trimmed = userPrompt.trim()
  if (!trimmed || trimmed.length < 20) return trimmed

  // Cache key: hash of full prompt to avoid collisions on similar prefixes
  const { createHash: createHashForKey } = await import("crypto")
  const cacheKey = createHashForKey("sha256").update(trimmed).digest("hex").slice(0, 32)
  const cached = hydeCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < HYDE_CACHE_TTL_MS) {
    return cached.expansion
  }

  const result = await callHaiku({
    model,
    systemPrompt: HYDE_SYSTEM_PROMPT,
    userMessage: `User prompt:\n${trimmed}`,
    maxTokens: 256,
    timeoutMs,
  })
  if (!result.ok || !result.text) {
    log.debug("HyDE expansion failed, using raw prompt", { error: result.error })
    return trimmed
  }
  // Concatenate original + expansion — gives BM25 both the exact terms
  // from the user's question and the technical vocabulary from the
  // hypothetical document.
  const expanded = `${trimmed}\n\n${result.text.trim()}`
  hydeCache.set(cacheKey, { expansion: expanded, ts: Date.now() })
  return expanded
}

/** Exposed for tests */
export function clearHydeCache(): void {
  hydeCache.clear()
}

export interface HybridWeights {
  bm25: number
  vector: number
  recency: number
  importance: number
  pagerank: number
  boost: number
}

export const HYBRID_WEIGHTS: HybridWeights = {
  bm25: 0.25,
  vector: 0.30,
  recency: 0.15,
  importance: 0.10,
  pagerank: 0.10,
  boost: 0.10,
}

export interface HybridRankOptions {
  limit?: number
  hybridWeights?: Partial<HybridWeights>
  recencyHalfLifeDays?: number
  pagerankScores?: Map<string, number>
  activeFiles?: Set<string>
  vectorStore?: VectorStore
  embedder?: Embedder | null
  queryVector?: Float32Array
  useFts5?: boolean
  minConfidence?: Confidence
}

const CONFIDENCE_BOOST: Record<string, number> = {
  extracted: 1.1,
  inferred: 1.0,
  ambiguous: 0.8,
}

function confidenceBoost(entry: MemoryEntry): number {
  return CONFIDENCE_BOOST[entry.confidence ?? ""] ?? 1.0
}

export async function hybridRank(
  scope: Scope,
  query: string,
  opts: HybridRankOptions = {},
): Promise<RankedEntry[]> {
  const limit = opts.limit ?? 20
  const half = opts.recencyHalfLifeDays ?? 30
  const useFts = opts.useFts5 !== false

  const order: Record<string, number> = { extracted: 2, inferred: 1, ambiguous: 0 }
  let entries = filterActive((await loadAllEntries(scope)).filter((e) => isValidAt(e)))
  if (opts.minConfidence) {
    const min = order[opts.minConfidence] ?? 0
    entries = entries.filter((e) => (order[e.confidence ?? ""] ?? -1) >= min)
  }
  if (entries.length === 0) return []

  const bm25Map = await computeRelevance(scope, query, entries, useFts)

  const vectorMap = new Map<string, number>()
  const qv = opts.queryVector ?? (await embedQuery(opts.embedder, query))
  if (qv && opts.vectorStore) {
    for (const hit of opts.vectorStore.search(qv, entries.length)) {
      vectorMap.set(hit.path, Math.max(0, hit.score))
    }
  }

  const bm25RankMap = new Map<string, number>()
  const vectorRankMap = new Map<string, number>()
  const recencyRankMap = new Map<string, number>()
  const pagerankRankMap = new Map<string, number>()

  const now = Date.now()
  for (const entry of entries) {
    const ageDays = Math.max(0, (now - entry.doc.mtimeMs) / (1000 * 60 * 60 * 24))
    const b = bm25Map.get(entry.doc.path) ?? 0
    if (b > 0) bm25RankMap.set(entry.doc.path, b)
    const v = vectorMap.get(entry.doc.path) ?? 0
    if (v > 0) vectorRankMap.set(entry.doc.path, v)
    recencyRankMap.set(entry.doc.path, Math.exp(-ageDays / half))
    pagerankRankMap.set(entry.doc.path, opts.pagerankScores?.get(entry.doc.path) ?? 0)
  }

  const rrfScores = rrfMerge([bm25RankMap, vectorRankMap, recencyRankMap, pagerankRankMap])

  // Relevance RRF (bm25 + vector only) → linearly rank-normalised to [0,1]
  // with tie-awareness. With k=60, raw differences between rank 1 and rank 2
  // are ~0.0002, so using raw scores directly would let importance override a
  // clear text-match winner. Linear normalization maps the best match to 1.0
  // and the worst to 0.0, giving the relevance signal its intended 55% weight.
  const relevanceRRF = rrfMerge([bm25RankMap, vectorRankMap])
  const relSorted = [...entries].sort(
    (a, b) => (relevanceRRF.get(b.doc.path) ?? 0) - (relevanceRRF.get(a.doc.path) ?? 0),
  )
  const relevanceScore = new Map<string, number>()
  const nEntries = relSorted.length
  let ri = 0
  while (ri < nEntries) {
    let rj = ri
    const baseVal = relevanceRRF.get(relSorted[ri].doc.path) ?? 0
    while (rj < nEntries - 1 && Math.abs(baseVal - (relevanceRRF.get(relSorted[rj + 1].doc.path) ?? 0)) < 1e-12)
      rj++
    const midRank = (ri + rj) / 2
    const normVal = nEntries > 1 ? (nEntries - 1 - midRank) / (nEntries - 1) : 1
    for (let rk = ri; rk <= rj; rk++) relevanceScore.set(relSorted[rk].doc.path, normVal)
    ri = rj + 1
  }

  const ranked: RankedEntry[] = entries.map((entry) => {
    const path = entry.doc.path
    const ageDays = Math.max(0, (now - entry.doc.mtimeMs) / (1000 * 60 * 60 * 24))
    const recency = Math.exp(-ageDays / half)
    const bm25 = bm25Map.get(path) ?? 0
    const vector = vectorMap.get(path) ?? 0
    const pagerank = opts.pagerankScores?.get(path) ?? 0
    const boost = fileBoost(entry, opts.activeFiles)
    const rel = relevanceScore.get(path) ?? 0
    const score =
      (rel * 0.55 + recency * 0.15 + entry.importance * 0.05 + pagerank * 0.10 + boost * 0.15) *
      confidenceBoost(entry)
    return {
      entry,
      score,
      breakdown: { recency, importance: entry.importance, relevance: bm25, pagerank, rrf: rrfScores.get(path) },
    }
  })

  ranked.sort((a, b) => b.score - a.score)

  // Community-aware boost: when top-K spans ≥2 communities, nudge the
  // majority community up by 5% so semantically-clustered notes win ties.
  const topK = ranked.slice(0, limit)
  const vi = getVaultIndex(scope.vaultRoot)
  const topCommunities = topK
    .map((r) => vi.getCommunity(r.entry.doc.path))
    .filter((c): c is number => c !== null)
  if (new Set(topCommunities).size >= 2) {
    const freq = new Map<number, number>()
    for (const c of topCommunities) freq.set(c, (freq.get(c) ?? 0) + 1)
    const majority = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0]
    for (const r of ranked) {
      if (vi.getCommunity(r.entry.doc.path) === majority) r.score *= 1.05
    }
    ranked.sort((a, b) => b.score - a.score)
  }

  return diversify(ranked, limit)
}

function diversify(ranked: RankedEntry[], limit: number): RankedEntry[] {
  const picked: RankedEntry[] = []
  const seen: Set<string>[] = []
  for (const r of ranked) {
    if (picked.length >= limit) break
    const t = candidateTokenize(r.entry.title + " " + r.entry.description)
    if (seen.some((s) => jaccard(t, s) > 0.75)) continue
    picked.push(r)
    seen.push(t)
  }
  return picked
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function fileBoost(entry: MemoryEntry, active?: Set<string>): number {
  if (!active || active.size === 0) return 0
  const text = entry.doc.body + " " + (entry.doc.meta["refs"] ?? "")
  let matches = 0
  for (const file of active) {
    const base = file.split("/").pop() ?? file
    if (text.includes(file)) matches += 2
    else if (base && text.includes(base)) matches += 1
  }
  return Math.min(1, matches / 4)
}

const queryCache = new Map<string, { vector: Float32Array; ts: number }>()
const QUERY_CACHE_TTL = 5 * 60 * 1000

async function embedQuery(embedder: Embedder | undefined | null, query: string): Promise<Float32Array | null> {
  if (!embedder || !query.trim()) return null
  const { createHash } = await import("crypto")
  const key = createHash("sha256").update(query).digest("hex").slice(0, 16)
  const hit = queryCache.get(key)
  if (hit && Date.now() - hit.ts < QUERY_CACHE_TTL) return hit.vector
  try {
    const results = await embedder.embed([query], "query")
    const v = results[0]?.vector ?? null
    if (v) queryCache.set(key, { vector: v, ts: Date.now() })
    return v
  } catch {
    return null
  }
}

export function clearQueryCache(): void {
  queryCache.clear()
}
