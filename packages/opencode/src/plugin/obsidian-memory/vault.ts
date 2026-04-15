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
  },
): Promise<string> {
  await fs.mkdir(scope.notesDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const titleSlug =
    (input.title || "note")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "note"
  const filename = `${ts}-${titleSlug}.md`
  const filepath = path.join(scope.notesDir, filename)
  const meta = {
    type: "memory-note",
    title: input.title,
    repo: scope.shortHash,
    branch: scope.branchSlug,
    created: new Date().toISOString(),
    ...(input.meta ?? {}),
  }
  const content = serializeFrontmatter(meta, input.body)
  await fs.writeFile(filepath, content, "utf8")

  if (!input.skipCommit) {
    const relpath = path.relative(scope.vaultRoot, filepath)
    const message =
      input.commitMessage ?? `memory(save): ${input.title || titleSlug} [${relpath}]`
    await VaultGit.ensureAndCommit(scope.vaultRoot, message)
  }

  return filepath
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
