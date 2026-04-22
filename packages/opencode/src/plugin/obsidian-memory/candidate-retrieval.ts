import { promises as fs } from "fs"
import path from "path"
import { parseFrontmatter } from "./frontmatter"
import { isValidAt, parseLinks, parseTags, toEntry } from "./parse-entry"
import type { MemoryDoc, MemoryEntry, Scope } from "./types"

/**
 * Lightweight candidate retrieval used by the capture gate BEFORE any LLM
 * call. Returns the top-K notes semantically closest to a probe (tags +
 * title tokens) so the Haiku gate can decide whether to ADD / UPDATE /
 * DELETE against a real candidate set.
 *
 * This is NOT full BM25 — that comes in the SQLite FTS5 phase. Here we
 * keep it dependency-free: Jaccard over token sets plus exact tag match.
 * Sufficient for 1-1000 memories per scope. Falls back to empty list on
 * any filesystem error.
 */

export interface CandidateProbe {
  /** Free-form text (e.g. prompt + tool summary) to extract tokens from */
  text: string
  /** Explicit tags to prefer */
  tags?: string[]
}

export interface Candidate {
  entry: MemoryEntry
  score: number
  signals: {
    tagOverlap: number
    tokenJaccard: number
    recencyDays: number
  }
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "with",
  "was",
  "were",
  "from",
  "that",
  "this",
  "have",
  "has",
  "had",
  "not",
  "but",
  "will",
  "would",
  "could",
  "should",
  "a",
  "an",
  "of",
  "to",
  "in",
  "is",
  "it",
  "be",
  "as",
  "or",
  "by",
  "on",
  "at",
  "do",
  "doesn",
  "didn",
  "don",
  "isn",
  "its",
  "you",
  "your",
  "use",
  "used",
])

/**
 * Tokenize free text into lowercased content words (len >= 3, no stopwords).
 * Exported for shared use by retrieval fallback scoring.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
    if (STOP_WORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Scan the branch notes dir + repo shared + system shared and return the
 * top-K candidate entries for a probe. Uses Promise.all for filesystem
 * parallelism; safe up to a few thousand notes per scope.
 */
export async function selectCandidates(
  scope: Scope,
  probe: CandidateProbe,
  opts: { limit?: number } = {},
): Promise<Candidate[]> {
  const limit = opts.limit ?? 10
  const entries = await loadAllEntries(scope)
  if (entries.length === 0) return []

  const probeTokens = tokenize(probe.text)
  const probeTags = new Set((probe.tags ?? []).map((t) => t.toLowerCase()))
  const now = Date.now()

  const scored: Candidate[] = []
  for (const entry of entries) {
    if (!isValidAt(entry, now)) continue
    const entryTokens = tokenize(`${entry.title} ${entry.description} ${entry.doc.body}`)
    const entryTags = new Set(entry.tags)
    const tokenJaccard = jaccard(probeTokens, entryTokens)
    let tagOverlap = 0
    for (const t of probeTags) if (entryTags.has(t)) tagOverlap++
    const tagScore = probeTags.size > 0 ? tagOverlap / probeTags.size : 0
    const ageDays = Math.max(0, (now - entry.doc.mtimeMs) / (1000 * 60 * 60 * 24))
    const recency = Math.exp(-ageDays / 30)

    // Require at least a minimal semantic signal — recency alone is NOT
    // enough to surface as a candidate (that would return the whole vault
    // for any query). Demand non-zero tag overlap or token jaccard.
    if (tagScore === 0 && tokenJaccard === 0) continue

    // Heuristic: tags dominate when present, otherwise token jaccard, with
    // a small recency nudge among semantically-matching entries.
    const score = Math.min(1, tagScore * 0.5 + tokenJaccard * 0.4 + recency * 0.1)
    if (score <= 0) continue
    scored.push({
      entry,
      score,
      signals: { tagOverlap, tokenJaccard, recencyDays: ageDays },
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/**
 * Load every markdown under the scope's notes dir + shared files into
 * MemoryEntry form. Skips files that fail to read or parse.
 *
 * Includes a UNION-SEARCH step: when the scope transitioned (e.g. non-git
 * → git, anchor-pinned across remote add), notes may still live under a
 * sibling slug. We also read:
 *
 *   - `scope.naturalRepoSlug` — the "natural" (pre-anchor) slug. Covers
 *     the grace period between first unanchored save and anchor write.
 *   - `<repoSlug>/branches/_nogit/notes` — notes saved while the dir was
 *     non-git, now visible from a git branch in the same repo.
 *   - `<repoSlug>/branches/main|master/notes` — notes saved while in git,
 *     now visible from a synthetic `_nogit` scope (after `.git` deletion).
 *
 * Disabled with `OBSIDIAN_MEMORY_DISABLE_UNION_SEARCH=1`.
 */
export async function loadAllEntries(scope: Scope): Promise<MemoryEntry[]> {
  const files: string[] = [
    scope.systemSharedPath,
    scope.repoSharedPath,
    scope.branchSharedPath,
  ]
  const notesDirs = new Set<string>([scope.notesDir])

  // Union search — add sibling directories that likely contain older notes.
  if (process.env.OBSIDIAN_MEMORY_DISABLE_UNION_SEARCH !== "1") {
    // (A) Natural repoSlug (pre-anchor) — includes its branch and _nogit.
    if (scope.naturalRepoSlug && scope.naturalRepoSlug !== scope.repoSlug) {
      const naturalRepoDir = path.join(scope.vaultRoot, "opencode", "repos", scope.naturalRepoSlug)
      if (scope.naturalBranchSlug && scope.naturalBranchSlug !== scope.branchSlug) {
        notesDirs.add(path.join(naturalRepoDir, "branches", scope.naturalBranchSlug, "notes"))
      }
      notesDirs.add(path.join(naturalRepoDir, "branches", "_nogit", "notes"))
      notesDirs.add(path.join(naturalRepoDir, "branches", "main", "notes"))
      notesDirs.add(path.join(naturalRepoDir, "branches", "master", "notes"))
    }

    // (B) Cross-branch siblings within the SAME repoSlug. Covers dir that
    // flipped from git → non-git (or vice-versa) without remote change.
    const currentRepoDir = path.join(scope.vaultRoot, "opencode", "repos", scope.repoSlug, "branches")
    if (scope.branchSlug !== "_nogit") notesDirs.add(path.join(currentRepoDir, "_nogit", "notes"))
    if (scope.branchSlug !== "main") notesDirs.add(path.join(currentRepoDir, "main", "notes"))
    if (scope.branchSlug !== "master") notesDirs.add(path.join(currentRepoDir, "master", "notes"))
  }

  for (const dir of notesDirs) {
    try {
      const entries = await fs.readdir(dir)
      for (const name of entries) {
        if (name.endsWith(".md")) files.push(path.join(dir, name))
      }
    } catch {
      // missing sibling dir — expected for most transitions
    }
  }

  // Deduplicate — sibling sharing of a single note (shouldn't happen with
  // mkdir-based writes, but guard is cheap) can cause double-loading.
  const seen = new Set<string>()
  const uniqueFiles = files.filter((f) => {
    if (seen.has(f)) return false
    seen.add(f)
    return true
  })

  const docs = await Promise.all(uniqueFiles.map(loadDocSilent))
  const out: MemoryEntry[] = []
  for (const doc of docs) {
    if (doc) out.push(toEntry(doc))
  }
  return out
}

async function loadDocSilent(filepath: string): Promise<MemoryDoc | null> {
  try {
    const [source, stat] = await Promise.all([
      fs.readFile(filepath, "utf8"),
      fs.stat(filepath),
    ])
    const { meta, body } = parseFrontmatter(source)
    return {
      path: filepath,
      meta,
      body,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }
  } catch {
    return null
  }
}

/** Expose raw helpers for testing */
export const __internal = {
  tokenize,
  jaccard,
  STOP_WORDS,
}
