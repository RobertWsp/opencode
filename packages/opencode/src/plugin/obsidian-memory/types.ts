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
