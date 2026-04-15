import { loadAllEntries, tokenize } from "./candidate-retrieval"
import { isValidAt, titleToSlug } from "./parse-entry"
import type { MemoryEntry, Scope } from "./types"

/**
 * Personalized PageRank over the wikilink graph of the vault. The node set
 * is {all valid memory entries}; edges are the outgoing `[[wikilinks]]`
 * extracted from each entry's body + frontmatter `links`.
 *
 * The "personalized" seeding injects extra teleport mass into nodes whose
 * title/tags overlap with the user's query tokens. Result: memories that
 * are both highly connected AND near the query topic rank higher than
 * isolated relevant notes.
 *
 * This is the HippoRAG-style contribution to retrieval (inspired by
 * Aider's repo map PageRank). Zero LLM cost — pure graph algorithm.
 *
 * Typical vault sizes (~100-1000 memories) converge in 20-30 iterations;
 * we cap at 50 iterations with eps 1e-5. Runtime is O(iterations * edges).
 */

export interface PageRankOptions {
  /** Teleport / damping factor */
  damping?: number
  /** Convergence epsilon */
  eps?: number
  /** Max power iterations */
  maxIter?: number
  /** Query tokens for personalized seeding (overlap → seed weight) */
  queryTokens?: Set<string>
  /** Explicit seed weights keyed by path (overrides query seeding) */
  seeds?: Map<string, number>
}

export interface PageRankResult {
  /** Map from absolute path → pagerank score in [0, 1] (normalized) */
  scores: Map<string, number>
  /** Total edges found in the graph */
  edgeCount: number
  /** Iterations performed before convergence */
  iterations: number
}

/**
 * Compute PageRank over the wikilink graph of a scope's valid memories.
 * When `queryTokens` or `seeds` is provided, teleport is biased toward
 * matching nodes (Personalized PageRank).
 */
export async function computePageRank(
  scope: Scope,
  opts: PageRankOptions = {},
): Promise<PageRankResult> {
  const damping = opts.damping ?? 0.85
  const eps = opts.eps ?? 1e-5
  const maxIter = opts.maxIter ?? 50

  const entries = (await loadAllEntries(scope)).filter((e) => isValidAt(e))
  const nodeCount = entries.length
  if (nodeCount === 0) {
    return { scores: new Map(), edgeCount: 0, iterations: 0 }
  }

  // Build index: path ↔ i, title slug → path (for link resolution)
  const pathByIndex = entries.map((e) => e.doc.path)
  const indexByPath = new Map<string, number>()
  const indexByTitle = new Map<string, number>()
  entries.forEach((entry, i) => {
    indexByPath.set(entry.doc.path, i)
    indexByTitle.set(titleToSlug(entry.title).toLowerCase(), i)
    indexByTitle.set(entry.title.toLowerCase(), i)
  })

  // Build adjacency via wikilinks: for each entry, resolve [[target]] to index
  const outEdges: number[][] = entries.map(() => [])
  let edgeCount = 0
  entries.forEach((entry, i) => {
    for (const link of entry.links) {
      const key = link.toLowerCase()
      const target =
        indexByTitle.get(key) ??
        indexByTitle.get(titleToSlug(link).toLowerCase())
      if (target !== undefined && target !== i) {
        outEdges[i].push(target)
        edgeCount++
      }
    }
  })

  // Compute seed distribution for personalized teleport
  const seedVec = computeSeedVector(entries, indexByPath, opts)

  // Power iteration
  let rank = new Float64Array(nodeCount).fill(1 / nodeCount)
  let iter = 0
  for (; iter < maxIter; iter++) {
    const next = new Float64Array(nodeCount)

    // Contribution from outgoing edges (random walk step)
    for (let i = 0; i < nodeCount; i++) {
      const edges = outEdges[i]
      if (edges.length === 0) {
        // Dangling node: distribute its mass uniformly across seeds
        const share = rank[i] / nodeCount
        for (let j = 0; j < nodeCount; j++) next[j] += share
      } else {
        const share = rank[i] / edges.length
        for (const j of edges) next[j] += share
      }
    }

    // Apply damping + teleport (personalized)
    let delta = 0
    for (let j = 0; j < nodeCount; j++) {
      next[j] = damping * next[j] + (1 - damping) * seedVec[j]
      delta += Math.abs(next[j] - rank[j])
    }

    rank = next
    if (delta < eps) {
      iter++
      break
    }
  }

  // Normalize to [0, 1] by dividing by max
  const scores = new Map<string, number>()
  const maxR = Math.max(...rank) || 1
  for (let i = 0; i < nodeCount; i++) {
    scores.set(pathByIndex[i], rank[i] / maxR)
  }
  return { scores, edgeCount, iterations: iter }
}

/**
 * Build the personalized teleport vector. If explicit seeds are given,
 * use them (renormalized). Otherwise, if query tokens are given, score
 * each node by token overlap in title+tags and normalize. Otherwise,
 * uniform over all nodes (vanilla PageRank).
 */
function computeSeedVector(
  entries: MemoryEntry[],
  indexByPath: Map<string, number>,
  opts: PageRankOptions,
): Float64Array {
  const n = entries.length
  const out = new Float64Array(n)

  if (opts.seeds && opts.seeds.size > 0) {
    let total = 0
    for (const [path, weight] of opts.seeds) {
      const idx = indexByPath.get(path)
      if (idx !== undefined && weight > 0) {
        out[idx] = weight
        total += weight
      }
    }
    if (total > 0) {
      for (let i = 0; i < n; i++) out[i] /= total
      return out
    }
  }

  const qt = opts.queryTokens
  if (qt && qt.size > 0) {
    let total = 0
    for (let i = 0; i < n; i++) {
      const entry = entries[i]
      const entryTokens = tokenize(
        `${entry.title} ${entry.description} ${entry.tags.join(" ")}`,
      )
      let overlap = 0
      for (const t of qt) if (entryTokens.has(t)) overlap++
      if (overlap > 0) {
        // Modest boost so well-matched seeds dominate teleport
        out[i] = 1 + overlap
        total += out[i]
      }
    }
    if (total > 0) {
      for (let i = 0; i < n; i++) out[i] /= total
      return out
    }
  }

  // Uniform fallback
  for (let i = 0; i < n; i++) out[i] = 1 / n
  return out
}

/**
 * Extract seed entities from a user prompt for personalized PageRank.
 * Uses the same tokenizer as candidate-retrieval so results match.
 */
export function seedsFromPrompt(prompt: string): Set<string> {
  return tokenize(prompt)
}
