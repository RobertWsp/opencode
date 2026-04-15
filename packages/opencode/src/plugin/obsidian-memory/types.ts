/**
 * Type declarations for the obsidian-memory plugin.
 *
 * Kept in a dedicated file to allow consumers (tests, other modules inside
 * the plugin) to import types without pulling in runtime code.
 */

/**
 * Taxonomy of memory entries. Adopted from LangMem / Voyager research
 * where separation between episodic / procedural / factual / decision
 * categories measurably improves retrieval quality.
 *
 * - `fact`: stable truth about the codebase ("API uses bearer auth")
 * - `decision`: architectural choice with rationale ("picked Zustand over Redux because X")
 * - `gotcha`: non-obvious bug or surprise ("build fails when X because Y")
 * - `skill`: procedural how-to ("how to run integration tests")
 * - `episode`: time-bound event ("on 2026-04-12 refactored auth module")
 * - `convention`: style/format rule ("always use kebab-case for CSS classes")
 */
export type MemoryKind =
  | "fact"
  | "decision"
  | "gotcha"
  | "skill"
  | "episode"
  | "convention"
  | "session-summary"
  | "learned-pattern"
  | "architecture"
  | "tech-context"
  | "progress"

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "decision",
  "gotcha",
  "skill",
  "episode",
  "convention",
  "session-summary",
  "learned-pattern",
  "architecture",
  "tech-context",
  "progress",
] as const

export function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value)
}

export function coerceMemoryKind(value: string | undefined): MemoryKind {
  if (value && isMemoryKind(value)) return value
  return "fact"
}

export interface MemoryConfig {
  enabled: boolean
  vaultPath?: string
  maxBytes: number
  maxNotes: number
  /** Enable automatic capture of events via Haiku gate (Phase 1) */
  autoCapture: boolean
  /** Haiku model ID used by the capture gate */
  captureModel: string
  /** Enable Sonnet-based consolidation batches (Phase 2) */
  autoConsolidate: boolean
  /** Sonnet model ID used by the consolidator */
  consolidateModel: string
  /**
   * Injection style (Phase 7 — progressive disclosure):
   * - "full":  inject entire MEMORY.md + notes bodies (MVP default, ~1-4KB)
   * - "index": inject a compact index (title + description + refs) only; LLM
   *   uses the `memory show` command to read full bodies on demand (~300-800B)
   */
  injectionStyle: "full" | "index"

  /**
   * When true, ranks injected notes via the composed retrieval scorer
   * (recency + importance + relevance + pagerank) instead of plain mtime
   * ordering. Requires no extra calls when HyDE is disabled — the scoring
   * is done against local BM25 / token jaccard.
   */
  smartRetrieval: boolean

  /**
   * When true, runs a Haiku HyDE query expansion before retrieval scoring.
   * Improves relevance when user prompts use different vocabulary than the
   * vault (e.g. "auth is broken" vs "JWT middleware rejects expired tokens").
   * Costs ~$0.0001 per injection, cached 5min.
   */
  hydeExpansion: boolean

  /**
   * When set (>0), captures with importance >= this threshold are held in
   * a `suggested/` staging area until the user runs `/memory approve` or
   * `/memory reject`. Lower-importance captures go directly into notes.
   * Pattern adopted from Cursor's sidecar model (Cursor Memories).
   */
  suggestThreshold: number
  sessionSummary?: boolean
  autoInit?: boolean
  embedApiKey?: string
  embedModel?: string
  embedDimensions?: number
}

export interface Scope {
  /** Absolute vault root, with ~ expanded */
  vaultRoot: string
  /** Human-readable repo name (filesystem only, never in prompt) */
  basename: string
  /** 6-char sha256 prefix of remote/topLevel, used in prompt wrapper */
  shortHash: string
  /** Full filesystem slug: `<basename>-<shortHash>` */
  repoSlug: string
  /** Original branch ref from git rev-parse --abbrev-ref HEAD */
  branchRaw: string
  /** Sanitized branch slug, <=60 chars, used in filesystem */
  branchSlug: string
  /** `<vault>/opencode/repos/<repoSlug>` */
  repoDir: string
  /** `<repoDir>/MEMORY.md` */
  repoSharedPath: string
  /** `<repoDir>/branches/<branchSlug>` */
  branchDir: string
  /** `<branchDir>/MEMORY.md` */
  branchSharedPath: string
  /** `<branchDir>/notes` */
  notesDir: string
  /** `<branchDir>/suggested` — staging area for suggest-mode captures */
  suggestedDir: string
  /** `<vault>/_system` — cross-repo user memories */
  systemDir: string
  /** `<systemDir>/MEMORY.md` — user preferences + feedback index */
  systemSharedPath: string
}

export interface MemoryDoc {
  /** Absolute filesystem path */
  path: string
  /** Parsed frontmatter (empty object when absent) */
  meta: Record<string, string>
  /** Body (everything after the closing `---`) */
  body: string
  /** File modification time in ms — used for ordering */
  mtimeMs: number
  /** File size in bytes */
  size: number
}

/**
 * Enriched view of a MemoryDoc with derived fields parsed from frontmatter
 * and body (kind, importance, links, bitemporal bounds). Built by the vault
 * loader and consumed by retrieval + injector.
 */
export interface MemoryEntry {
  doc: MemoryDoc
  kind: MemoryKind
  title: string
  description: string
  tags: string[]
  /** Outgoing wikilinks `[[foo]]` extracted from body + frontmatter `links` */
  links: string[]
  /** Importance score 0-1 from the capture gate (or user-assigned) */
  importance: number
  /** ISO timestamp of logical creation (frontmatter `created` or fallback) */
  created: string
  /** ISO timestamp when the fact became true (defaults to `created`) */
  validFrom: string
  /** ISO timestamp when invalidated; null means still valid */
  validUntil: string | null
  /** Wikilink slug of the note that superseded this one */
  supersededBy: string | null
}

export interface VaultDocs {
  /** User-level cross-repo memories (preferences, feedback) */
  systemShared?: MemoryDoc
  /** Repo-level shared MEMORY.md, if it exists */
  repoShared?: MemoryDoc
  /** Branch-level shared MEMORY.md, if it exists */
  branchShared?: MemoryDoc
  /** Recent notes, sorted newest-first */
  notes: MemoryDoc[]
}

export interface InjectorOptions {
  maxBytes: number
}
