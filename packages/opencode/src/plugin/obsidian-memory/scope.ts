import { createHash } from "crypto"
import { realpathSync } from "fs"
import os from "os"
import path from "path"
import { git } from "../../util/git"
import { readAnchor } from "./scope-anchor"
import type { Scope } from "./types"

/**
 * Resolve the current (repo, branch) scope from a worktree path.
 *
 * Happy path: uses git to determine the remote URL (for stable slugging
 * across clones), the topLevel path (fallback identity), and the current
 * branch.
 *
 * Non-git path (fallback): when git is unavailable or the worktree is not
 * inside a git repository, falls back to a synthetic scope derived from
 * the directory's realpath. The memory vault still works — just without
 * branch awareness. Disable via env `OBSIDIAN_MEMORY_REQUIRE_GIT=1` if
 * you prefer the pre-2026-04 strict behavior.
 *
 * Returns `null` only when the vault path is unset or the worktree path
 * is empty. Accessible non-git directories always produce a synthetic
 * scope in the default (non-strict) mode.
 */
export async function detectScope(opts: {
  worktree: string
  vaultPath?: string
}): Promise<Scope | null> {
  if (!opts.vaultPath) return null
  const cwd = opts.worktree
  if (!cwd) return null

  const vaultRoot = expandTilde(opts.vaultPath)
  const systemDir = path.join(vaultRoot, "_system")
  const strictGit = process.env.OBSIDIAN_MEMORY_REQUIRE_GIT === "1"

  // Read the scope anchor early — if present, its repoSlug overrides the
  // natural detection result. This keeps memory reachable across git init,
  // remote add/remove, `.git` deletion, and dir renames.
  const anchorResult = await readAnchor(cwd)
  const anchor = anchorResult.anchor

  const natural = await detectNatural(cwd, vaultRoot, systemDir, strictGit)
  if (!natural) return null

  if (anchor && anchor.repoSlug && anchor.repoSlug !== natural.repoSlug) {
    return { ...applyAnchor(natural, anchor.repoSlug, vaultRoot), worktree: cwd }
  }
  return { ...natural, worktree: cwd }
}

/**
 * Natural (unanchored) scope derivation. Split from detectScope so the
 * anchor override has a single, well-typed path.
 */
async function detectNatural(
  cwd: string,
  vaultRoot: string,
  systemDir: string,
  strictGit: boolean,
): Promise<Scope | null> {
  try {
    const remoteRes = await git(["config", "--get", "remote.origin.url"], { cwd })
    const topLevelRes = await git(["rev-parse", "--show-toplevel"], { cwd })
    const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })

    if (topLevelRes.exitCode !== 0) {
      if (strictGit) return null
      return buildSyntheticScope(cwd, vaultRoot, systemDir)
    }

    const remote = remoteRes.exitCode === 0 ? remoteRes.text().trim() : ""
    const topLevel = topLevelRes.text().trim() || cwd
    const branchRaw = branchRes.exitCode === 0 ? branchRes.text().trim() : ""

    const identity = canonicalizeRemote(remote) || canonicalizeLocal(topLevel)
    if (!identity) {
      if (strictGit) return null
      return buildSyntheticScope(cwd, vaultRoot, systemDir)
    }

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
      suggestedDir: path.join(branchDir, "suggested"),
      systemDir,
      systemSharedPath: path.join(systemDir, "MEMORY.md"),
    }
  } catch {
    if (strictGit) return null
    return buildSyntheticScope(cwd, vaultRoot, systemDir)
  }
}

/**
 * Overlay an anchored repoSlug onto a natural scope. Preserves the
 * natural values as `naturalRepoSlug` / `naturalBranchSlug` so the
 * retrieval layer can union-search both slugs and uncover notes written
 * before the anchor existed (e.g. first save was unanchored).
 */
function applyAnchor(natural: Scope, anchoredSlug: string, vaultRoot: string): Scope {
  // naturalBranchSlug is only meaningful when the branch would differ, e.g.
  // a previously-synthetic `_nogit` session is now on `main`. Set it only
  // when the natural branch is synthetic/main/master — older notes are
  // most likely there. For exotic branches we preserve them verbatim in
  // the normal path.
  const naturalBranchSlug = natural.branchSlug
  const repoDir = path.join(vaultRoot, "opencode", "repos", anchoredSlug)
  const branchDir = path.join(repoDir, "branches", natural.branchSlug)
  return {
    ...natural,
    repoSlug: anchoredSlug,
    repoDir,
    repoSharedPath: path.join(repoDir, "MEMORY.md"),
    branchDir,
    branchSharedPath: path.join(branchDir, "MEMORY.md"),
    notesDir: path.join(branchDir, "notes"),
    suggestedDir: path.join(branchDir, "suggested"),
    anchored: true,
    naturalRepoSlug: natural.repoSlug,
    naturalBranchSlug,
  }
}

/**
 * Synthetic scope for directories that are not inside a git repository.
 *
 * Partitions memory per-directory (via realpath) so two unrelated non-git
 * workspaces (e.g. /tmp/poc-a vs /tmp/poc-b) get separate vault entries.
 * Branch slug is always `_nogit` — synthetic scopes have no branch concept.
 *
 * VaultGit.commit() is best-effort (wrapped in try/catch upstream) so
 * commits from a non-git worktree still land in the vault's OWN git
 * history (~/Obsidian/dev-memory) without issue.
 */
function buildSyntheticScope(
  cwd: string,
  vaultRoot: string,
  systemDir: string,
): Scope {
  const identity = canonicalizeLocal(cwd)
  const basename = deriveBasename(identity)
  const shortHash = createHash("sha256").update(identity).digest("hex").slice(0, 6)
  const repoSlug = `${basename}-${shortHash}`
  const branchSlug = "_nogit"
  const repoDir = path.join(vaultRoot, "opencode", "repos", repoSlug)
  const branchDir = path.join(repoDir, "branches", branchSlug)

  return {
    vaultRoot,
    basename,
    shortHash,
    repoSlug,
    branchRaw: "",
    branchSlug,
    repoDir,
    repoSharedPath: path.join(repoDir, "MEMORY.md"),
    branchDir,
    branchSharedPath: path.join(branchDir, "MEMORY.md"),
    notesDir: path.join(branchDir, "notes"),
    suggestedDir: path.join(branchDir, "suggested"),
    systemDir,
    systemSharedPath: path.join(systemDir, "MEMORY.md"),
    synthetic: true,
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
  const base = (cleaned || "branch").slice(0, 60)
  if (base === raw) return base
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 4)
  return `${base.slice(0, 55)}-${suffix}`
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}
