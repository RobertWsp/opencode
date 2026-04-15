import { createHash } from "crypto"
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

    const identity = remote || topLevel
    if (!identity) return null

    const basenameSource = remote ? remote.replace(/\.git$/, "") : topLevel
    const basename = slugify(path.basename(basenameSource)) || "repo"
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
