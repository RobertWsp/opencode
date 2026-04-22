import { promises as fs } from "fs"
import path from "path"

/**
 * Scope anchor — a small JSON file the plugin drops at the root of a
 * project directory to pin its identity in the vault across transitions:
 *
 *   1. non-git dir → `git init` (branch flip but same or new repoSlug)
 *   2. git repo → `rm -rf .git` (branch flip; remote-less repos keep slug,
 *      repos with a remote LOSE the remote-based slug without the anchor)
 *   3. non-git dir → `git init` + `git remote add origin` (full identity flip)
 *   4. dir rename/move (realpath changes, synthetic hash would drift)
 *
 * File: `.obsidian-memory-scope.json` at the worktree root. When present,
 * `detectScope()` reads the pinned repoSlug from here instead of rederiving
 * from git metadata or realpath.
 *
 * Format is intentionally minimal and forward-compatible via the `version`
 * field. Breaking changes bump the version; older plugins ignore anchors
 * with an unknown version and fall through to normal detection.
 *
 * USER OPT-OUT: deleting the anchor triggers re-detection on the next
 * call. Adding it to the project's `.gitignore` is recommended so cloned
 * replicas don't inherit the originating machine's slug.
 */

export const ANCHOR_FILENAME = ".obsidian-memory-scope.json"
export const ANCHOR_VERSION = 1 as const

export interface ScopeAnchor {
  version: number
  /** Full filesystem slug: `<basename>-<shortHash>`. Pinned. */
  repoSlug: string
  /** Human-readable identity hint for debugging. */
  identity?: string
  /** ISO-8601 creation timestamp. */
  createdAt: string
  /** Optional note from the user or tooling. */
  note?: string
}

export interface AnchorReadResult {
  anchor: ScopeAnchor | null
  /** File existed but was unreadable/invalid — surface for diagnostics. */
  invalid?: boolean
  /** Absolute path the read attempted. */
  path: string
}

/**
 * Read the anchor file at `worktree`. Returns `{ anchor: null }` when the
 * file is absent OR when reading/parsing/validation fails (never throws).
 * On invalid content, `invalid: true` is set so callers can log a warning
 * without blocking the normal detection path.
 */
export async function readAnchor(worktree: string): Promise<AnchorReadResult> {
  const anchorPath = path.join(worktree, ANCHOR_FILENAME)
  try {
    const raw = await fs.readFile(anchorPath, "utf8")
    const parsed = JSON.parse(raw) as Partial<ScopeAnchor>
    if (!isValidAnchor(parsed)) {
      return { anchor: null, invalid: true, path: anchorPath }
    }
    return { anchor: parsed, path: anchorPath }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { anchor: null, path: anchorPath }
    }
    return { anchor: null, invalid: true, path: anchorPath }
  }
}

/**
 * Write the anchor atomically (tmp file + rename). Best-effort: any I/O
 * error resolves to `false` so upstream callers never crash when the
 * worktree is read-only (e.g. archived projects, CI checkouts).
 */
export async function writeAnchor(
  worktree: string,
  anchor: ScopeAnchor,
): Promise<boolean> {
  if (!isValidAnchor(anchor)) return false
  const anchorPath = path.join(worktree, ANCHOR_FILENAME)
  const tmpPath = `${anchorPath}.tmp-${process.pid}-${Date.now()}`
  try {
    const serialized = JSON.stringify(anchor, null, 2) + "\n"
    await fs.writeFile(tmpPath, serialized, { mode: 0o644 })
    await fs.rename(tmpPath, anchorPath)
    return true
  } catch {
    await fs.unlink(tmpPath).catch(() => undefined)
    return false
  }
}

/**
 * Convenience factory for a new anchor matching the detection result's
 * identity. Callers usually pair this with `writeAnchor()` on first save.
 */
export function createAnchor(opts: {
  repoSlug: string
  identity?: string
  note?: string
}): ScopeAnchor {
  return {
    version: ANCHOR_VERSION,
    repoSlug: opts.repoSlug,
    identity: opts.identity,
    createdAt: new Date().toISOString(),
    note: opts.note,
  }
}

/**
 * Validate an anchor shape. Enforced at read AND write time so neither
 * direction silently accepts malformed data.
 */
export function isValidAnchor(value: unknown): value is ScopeAnchor {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.version !== "number" || v.version < 1) return false
  if (typeof v.repoSlug !== "string" || v.repoSlug.length === 0) return false
  if (typeof v.createdAt !== "string") return false
  // Tolerate unknown future versions — reader will ignore; writer emits
  // the current one. Schema additions never break older plugins.
  if (v.version !== ANCHOR_VERSION) return false
  if (v.identity !== undefined && typeof v.identity !== "string") return false
  if (v.note !== undefined && typeof v.note !== "string") return false
  return true
}
