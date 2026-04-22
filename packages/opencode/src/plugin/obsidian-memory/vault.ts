import { createHash } from "crypto"
import { promises as fs } from "fs"
import path from "path"
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter"
import type { MemoryDoc, Scope, VaultDocs } from "./types"
import { VaultGit } from "./vault-git"

/**
 * Deterministic fingerprint of the vault state relevant to a given scope.
 *
 * Covers:
 * - Repo shared MEMORY.md
 * - Branch shared MEMORY.md
 * - All notes in the branch notes dir (sorted by name for stability)
 *
 * Only stat metadata (mtimeMs + size) is hashed, NOT file contents — this
 * keeps the check fast and allows the plugin to decide whether to re-read
 * the actual files without paying for disk IO on every turn.
 *
 * Returns a 16-char hex prefix (64 bits) which is plenty for cache keying.
 */
export async function fingerprint(scope: Scope): Promise<string> {
  const hash = createHash("sha256")
  const targets: string[] = [
    scope.systemSharedPath,
    scope.repoSharedPath,
    scope.branchSharedPath,
  ]
  try {
    const entries = await fs.readdir(scope.notesDir)
    for (const entry of entries.sort()) {
      targets.push(path.join(scope.notesDir, entry))
    }
  } catch {
    // notes dir missing is fine
  }

  for (const target of targets) {
    try {
      const st = await fs.stat(target)
      hash.update(`${target}:${st.mtimeMs}:${st.size}\n`)
    } catch {
      hash.update(`${target}:MISSING\n`)
    }
  }
  return hash.digest("hex").slice(0, 16)
}

/**
 * Read all memory files relevant to a given scope.
 *
 * - Missing files are silently ignored (returns undefined for shared docs,
 *   empty array for notes).
 * - Notes are sorted newest-first by mtime, with path as tie-breaker.
 * - Non-`.md` files in the notes dir are skipped.
 */
export async function loadAll(scope: Scope, maxNotes = 20): Promise<VaultDocs> {
  const [systemShared, repoShared, branchShared] = await Promise.all([
    loadDoc(scope.systemSharedPath),
    loadDoc(scope.repoSharedPath),
    loadDoc(scope.branchSharedPath),
  ])

  const notes: MemoryDoc[] = []
  try {
    const entries = await fs.readdir(scope.notesDir)
    const mdEntries = entries.filter((e) => e.endsWith(".md"))
    const docs = await Promise.all(
      mdEntries.map((e) => loadDoc(path.join(scope.notesDir, e))),
    )
    for (const doc of docs) {
      if (doc) notes.push(doc)
    }
    notes.sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
      return a.path.localeCompare(b.path)
    })
  } catch {
    // notes dir missing — no notes to load
  }

  return {
    systemShared: systemShared ?? undefined,
    repoShared: repoShared ?? undefined,
    branchShared: branchShared ?? undefined,
    notes: notes.slice(0, maxNotes),
  }
}

/**
 * Write a new note file under `<scope.notesDir>`. Creates parent dirs if
 * needed. Returns the absolute path written.
 */
export async function writeNote(
  scope: Scope,
  input: {
    title: string
    meta?: Record<string, string>
    body: string
    /** Override default commit message; falls back to "save" template */
    commitMessage?: string
    /** Skip git commit entirely (used by batch callers that commit themselves) */
    skipCommit?: boolean
    /** Optional explicit target directory; defaults to branch notesDir */
    targetDir?: string
  },
): Promise<string> {
  const dir = input.targetDir ?? scope.notesDir
  await fs.mkdir(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const titleSlug =
    (input.title || "note")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "note"
  const filename = `${ts}-${titleSlug}.md`
  const filepath = path.join(dir, filename)
  const now = new Date().toISOString()
  const meta: Record<string, string> = {
    type: "memory-note",
    "memory-kind": input.meta?.["memory-kind"] ?? "fact",
    title: input.title,
    repo: scope.shortHash,
    branch: scope.branchSlug,
    created: now,
    valid_from: now,
    valid_until: "null",
    ...(input.meta ?? {}),
  }
  // Ensure bitemporal defaults are NOT overwritten with undefined values
  if (!meta["valid_from"]) meta["valid_from"] = now
  if (meta["valid_until"] === undefined) meta["valid_until"] = "null"

  const content = serializeFrontmatter(meta, input.body)
  await fs.writeFile(filepath, content, "utf8")

  if (!input.skipCommit) {
    const relpath = path.relative(scope.vaultRoot, filepath)
    const message =
      input.commitMessage ?? `memory(save): ${input.title || titleSlug} [${relpath}]`
    await VaultGit.ensureAndCommit(scope.vaultRoot, message)
  }

  // Drop a scope anchor in the worktree on first successful save so the
  // repoSlug survives git transitions (init, remote add, .git deletion,
  // dir rename). Best-effort: failures never propagate.
  await maybeEmitAnchor(scope).catch(() => undefined)

  return filepath
}

async function maybeEmitAnchor(scope: Scope): Promise<void> {
  if (!scope.worktree) return
  if (process.env.OBSIDIAN_MEMORY_DISABLE_ANCHOR === "1") return
  const { readAnchor, writeAnchor, createAnchor } = await import("./scope-anchor")
  const existing = await readAnchor(scope.worktree)
  if (existing.anchor) return
  // Emit for BOTH synthetic and git scopes. Synthetic anchors pay forward:
  // if the user later `git init`s and adds a remote, the anchor pins the
  // synthetic slug so memories stay reachable. Without this, the
  // non-git → git+remote transition loses identity.
  const anchor = createAnchor({
    repoSlug: scope.repoSlug,
    identity: scope.synthetic
      ? scope.basename + " (no-git, pinned)"
      : scope.basename + " (" + scope.branchSlug + ")",
    note:
      "Auto-written on first memory save. Delete to force re-detection. " +
      "Add to .gitignore so clones don't inherit this machine's slug.",
  })
  await writeAnchor(scope.worktree, anchor)
}

/**
 * Rewrite an existing memory file in-place while preserving as much of the
 * original frontmatter as possible. Used by the 4-op gate for UPDATE.
 *
 * Merges `meta` patch into the existing frontmatter and replaces the body.
 * Sets `updated` to now. Commit is optional.
 */
export async function rewriteNote(
  scope: Scope,
  filepath: string,
  input: {
    meta?: Record<string, string>
    body: string
    commitMessage?: string
    skipCommit?: boolean
  },
): Promise<boolean> {
  const source = await fs.readFile(filepath, "utf8").catch(() => null)
  if (source === null) return false
  const { meta: existing } = parseFrontmatter(source)
  const merged: Record<string, string> = {
    ...existing,
    ...(input.meta ?? {}),
    updated: new Date().toISOString(),
  }
  const content = serializeFrontmatter(merged, input.body)
  await fs.writeFile(filepath, content, "utf8")

  if (!input.skipCommit) {
    const relpath = path.relative(scope.vaultRoot, filepath)
    const message =
      input.commitMessage ??
      `memory(update): ${merged["title"] ?? path.basename(filepath)} [${relpath}]`
    await VaultGit.ensureAndCommit(scope.vaultRoot, message)
  }
  return true
}

/**
 * Mark a memory as invalidated (bitemporal "soft delete"). Sets `valid_until`
 * to now and optionally records a `superseded_by` link. The file stays on
 * disk so git history and `git blame` continue to work; the injector filters
 * invalidated entries at read time.
 */
export async function invalidateNote(
  scope: Scope,
  filepath: string,
  input: {
    reason?: string
    supersededBy?: string
    commitMessage?: string
    skipCommit?: boolean
  } = {},
): Promise<boolean> {
  const source = await fs.readFile(filepath, "utf8").catch(() => null)
  if (source === null) return false
  const { meta: existing, body } = parseFrontmatter(source)
  const now = new Date().toISOString()
  const merged: Record<string, string> = {
    ...existing,
    valid_until: now,
    invalidated: now,
  }
  if (input.reason) merged["invalidation_reason"] = input.reason
  if (input.supersededBy) merged["superseded_by"] = `[[${input.supersededBy.replace(/^\[\[|\]\]$/g, "")}]]`

  const content = serializeFrontmatter(merged, body)
  await fs.writeFile(filepath, content, "utf8")

  if (!input.skipCommit) {
    const relpath = path.relative(scope.vaultRoot, filepath)
    const message =
      input.commitMessage ??
      `memory(invalidate): ${existing["title"] ?? path.basename(filepath)}${input.reason ? ` — ${input.reason}` : ""} [${relpath}]`
    await VaultGit.ensureAndCommit(scope.vaultRoot, message)
  }
  return true
}

async function loadDoc(filepath: string): Promise<MemoryDoc | null> {
  try {
    const [source, st] = await Promise.all([fs.readFile(filepath, "utf8"), fs.stat(filepath)])
    const { meta, body } = parseFrontmatter(source)
    return {
      path: filepath,
      meta,
      body,
      mtimeMs: st.mtimeMs,
      size: st.size,
    }
  } catch {
    return null
  }
}
