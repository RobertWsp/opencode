import { createHash } from "crypto"
import { realpathSync } from "fs"
import os from "os"
import path from "path"
import { git } from "../../util/git"
import type { Scope } from "./types"

/**
 * Resolve the current (repo, branch) scope from a worktree path.
 *
 * Uses git to determine the remote URL (for stable slugging across clones),
 * the topLevel path (fallback identity), and the current branch. Returns
 * `null` when git is not available, the vault path is not configured, or
 * the worktree is not inside a git repository.
 */
export async function detectScope(opts: {
  worktree: string
  vaultPath?: string
}): Promise<Scope | null> {
  if (!opts.vaultPath) return null
  const cwd = opts.worktree
  if (!cwd) return null

  try {
    const remoteRes = await git(["config", "--get", "remote.origin.url"], { cwd })
    const topLevelRes = await git(["rev-parse", "--show-toplevel"], { cwd })
    const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })

    if (topLevelRes.exitCode !== 0) return null

    const remote = remoteRes.exitCode === 0 ? remoteRes.text().trim() : ""
    const topLevel = topLevelRes.text().trim() || cwd
    const branchRaw = branchRes.exitCode === 0 ? branchRes.text().trim() : ""

    // Canonical identity: normalize remote URL so all forms of the same repo
    // (ssh, https, with/without .git) produce the same hash. Falls back to
    // realpath-resolved topLevel for repos without a remote.
    const identity = canonicalizeRemote(remote) || canonicalizeLocal(topLevel)
    if (!identity) return null

    const basename = deriveBasename(identity)
    const shortHash = createHash("sha256").update(identity).digest("hex").slice(0, 6)
    const repoSlug = `${basename}-${shortHash}`

    let branchSlug: string
    if (!branchRaw || branchRaw === "HEAD") {
      const shaRes = await git(["rev-parse", "--short", "HEAD"], { cwd })
      const sha = shaRes.exitCode === 0 ? shaRes.text().trim() : ""
      branchSlug = `_detached-${sha || "unknown"}`
    } else {
      branchSlug = sanitizeBranch(branchRaw)
    }

    const vaultRoot = expandTilde(opts.vaultPath)
    const repoDir = path.join(vaultRoot, "opencode", "repos", repoSlug)
    const branchDir = path.join(repoDir, "branches", branchSlug)
    const systemDir = path.join(vaultRoot, "_system")

    return {
      vaultRoot,
      basename,
      shortHash,
      repoSlug,
      branchRaw,
      branchSlug,
      repoDir,
      repoSharedPath: path.join(repoDir, "MEMORY.md"),
      branchDir,
      branchSharedPath: path.join(branchDir, "MEMORY.md"),
      notesDir: path.join(branchDir, "notes"),
      suggestedDir: path.join(branchDir, "suggested"),
      systemDir,
      systemSharedPath: path.join(systemDir, "MEMORY.md"),
    }
  } catch {
    return null
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Normalize a git remote URL into a canonical `host/owner/name` form so that
 * all protocols and variants of the same repository produce identical hashes.
 *
 * Handles:
 * - `git@host:owner/repo.git`      → `host/owner/repo`
 * - `ssh://git@host/owner/repo.git`→ `host/owner/repo`
 * - `https://host/owner/repo.git`  → `host/owner/repo`
 * - `https://user:token@host/a/b`  → `host/a/b`    (drops credentials)
 * - `file:///path/to/repo`         → `path/to/repo`
 *
 * Returns empty string if input is empty or unparseable.
 */
export function canonicalizeRemote(remote: string): string {
  const trimmed = remote.trim()
  if (!trimmed) return ""

  // Drop trailing .git and trailing slashes
  const stripped = trimmed.replace(/\.git\/?$/, "").replace(/\/+$/, "")

  // scp-like syntax: git@host:owner/repo (no protocol)
  const scpMatch = stripped.match(/^(?:[^@/:]+@)?([^:/]+):(.+)$/)
  if (scpMatch && !stripped.startsWith("http") && !stripped.includes("://")) {
    const host = scpMatch[1].toLowerCase()
    const pathPart = scpMatch[2].replace(/^\/+/, "")
    return `${host}/${pathPart}`
  }

  // URL-like: protocol://[user[:pass]@]host[:port]/path
  const urlMatch = stripped.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i)
  if (urlMatch) {
    const host = urlMatch[1].toLowerCase()
    const pathPart = urlMatch[2].replace(/^\/+/, "")
    return `${host}/${pathPart}`
  }

  // Fallback: return as-is (already normalized or unknown form)
  return stripped.toLowerCase()
}

/**
 * Normalize a local worktree path for repos without a remote. Resolves
 * symlinks so the same repo reached via different paths produces the same
 * hash. Still machine-specific — a no-remote repo cannot sync across hosts.
 */
export function canonicalizeLocal(topLevel: string): string {
  if (!topLevel) return ""
  try {
    return `local:${realpathSync(topLevel)}`
  } catch {
    return `local:${path.resolve(topLevel)}`
  }
}

/**
 * Derive a human-readable basename from a canonical identity string.
 * Uses the last path segment, slugified.
 */
export function deriveBasename(identity: string): string {
  const lastSegment = identity.split("/").filter(Boolean).pop() ?? ""
  const cleaned = lastSegment.replace(/^local:/, "")
  return slugify(path.basename(cleaned)) || "repo"
}

function sanitizeBranch(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return (cleaned || "branch").slice(0, 60)
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}
