import { Log } from "../../util/log"
import { loadAllEntries, tokenize as candidateTokenize } from "./candidate-retrieval"
import { callHaiku } from "./haiku-client"
import { isValidAt } from "./parse-entry"
import type { MemoryEntry, Scope } from "./types"
import { VaultIndex, type FtsHit } from "./vault-index"

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

  const entries = (await loadAllEntries(scope)).filter((e) => isValidAt(e))
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
      const index = new VaultIndex(scope.vaultRoot)
      // Lazy rebuild if index is empty and we have entries to search.
      if (index.count() === 0 && entries.length > 0) {
        await index.rebuild(scope)
      }
      const hits = index.search(query, Math.max(entries.length, 50))
      index.close()
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
