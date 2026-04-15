/**
 * Type declarations for the obsidian-memory plugin.
 *
 * Kept in a dedicated file to allow consumers (tests, other modules inside
 * the plugin) to import types without pulling in runtime code.
 */

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
