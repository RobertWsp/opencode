import { promises as fs } from "fs"
import path from "path"
import { git } from "../../util/git"
import type { MemoryDoc } from "./types"

/**
 * File reference verification — keeps memories honest about the code they
 * point to. A memory with a broken ref is like a comment referencing
 * a deleted function: worse than nothing because it confidently asserts
 * stale information.
 *
 * Workflow inspired by GitHub Copilot's agentic memory just-in-time verification:
 * before injecting a memory into the prompt, we validate each ref. Memories
 * with all-broken refs are skipped entirely; memories with partially-broken
 * refs get a `<stale>` marker so the model knows to treat that section with
 * caution.
 *
 * Refs can appear in the frontmatter as:
 *
 *   refs: "src/foo.ts:42-58,src/bar.ts"
 *
 * or as a newline-separated list in the body after a `Refs:` heading.
 * Both forms are recognized.
 */
export interface Ref {
  /** Path relative to the worktree root */
  path: string
  /** Optional line range: [startLine, endLine] (1-based, inclusive) */
  lines?: [number, number]
}

export interface RefStatus {
  ref: Ref
  /** True if the file still exists at the worktree root */
  exists: boolean
  /** True if the ref is considered valid (exists + line range intact if specified) */
  valid: boolean
  /** Optional human description when invalid */
  reason?: string
}

export interface DocRefHealth {
  refs: RefStatus[]
  /** True iff at least one ref is valid (the memory is still usable) */
  anyValid: boolean
  /** True iff ALL refs are broken (the memory should be skipped) */
  allBroken: boolean
  /** Count of broken refs */
  brokenCount: number
}

const REF_LINE_RE = /^\s*(?:-\s+)?(?:@)?([^\s:@]+)(?::(\d+)(?:-(\d+))?)?\s*$/

/**
 * Parse refs from a memory doc. Looks in two places:
 * 1. `refs` frontmatter field (comma-separated)
 * 2. A markdown section starting with `Refs:` or `## References` — one per line
 *
 * Returns an empty array when no refs are found.
 */
export function parseRefs(doc: MemoryDoc): Ref[] {
  const refs: Ref[] = []

  const fromMeta = doc.meta["refs"]
  if (fromMeta) {
    for (const raw of fromMeta.split(",")) {
      const ref = parseRef(raw)
      if (ref) refs.push(ref)
    }
  }

  const body = doc.body
  const refsHeading = body.match(/(?:^|\n)(?:##?\s*Refs?|##?\s*References?|Refs?:)\s*\n([\s\S]+?)(?:\n\n|\n##|\n$|$)/i)
  if (refsHeading) {
    for (const line of refsHeading[1].split(/\r?\n/)) {
      const ref = parseRef(line)
      if (ref) refs.push(ref)
    }
  }

  // Dedupe by path+lines signature
  const seen = new Set<string>()
  return refs.filter((r) => {
    const key = `${r.path}:${r.lines?.[0] ?? ""}-${r.lines?.[1] ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseRef(raw: string): Ref | null {
  const trimmed = raw.trim().replace(/^[-*]\s+/, "").replace(/^@/, "")
  if (!trimmed || trimmed.startsWith("#")) return null
  const match = trimmed.match(REF_LINE_RE)
  if (!match) return null
  const filepath = match[1]
  if (!filepath || filepath.includes(" ")) return null
  const start = match[2] ? parseInt(match[2], 10) : undefined
  const end = match[3] ? parseInt(match[3], 10) : start
  if (start !== undefined && end !== undefined) {
    return { path: filepath, lines: [start, end] }
  }
  return { path: filepath }
}

/**
 * Check a single ref against the worktree HEAD. `exists` requires the file
 * to be present; `valid` additionally requires the line range (if any) to
 * fit within the current file length.
 */
export async function verifyRef(worktree: string, ref: Ref): Promise<RefStatus> {
  const abs = path.resolve(worktree, ref.path)
  // Guard against escaping the worktree via ../
  const rootWithSep = worktree.endsWith(path.sep) ? worktree : worktree + path.sep
  if (!abs.startsWith(rootWithSep) && abs !== worktree) {
    return { ref, exists: false, valid: false, reason: "path escapes worktree" }
  }
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile()) {
      return { ref, exists: false, valid: false, reason: "not a regular file" }
    }
  } catch {
    return { ref, exists: false, valid: false, reason: "file missing" }
  }

  if (!ref.lines) return { ref, exists: true, valid: true }

  // Check line range is within bounds
  try {
    const content = await fs.readFile(abs, "utf8")
    const lineCount = content.split(/\r?\n/).length
    const [start, end] = ref.lines
    if (start < 1 || end > lineCount) {
      return {
        ref,
        exists: true,
        valid: false,
        reason: `range ${start}-${end} exceeds file (${lineCount} lines)`,
      }
    }
    return { ref, exists: true, valid: true }
  } catch {
    return { ref, exists: true, valid: false, reason: "unreadable" }
  }
}

/**
 * Verify all refs for a single memory doc. Result is cached by caller
 * because verification requires filesystem IO.
 */
export async function verifyDocRefs(worktree: string, doc: MemoryDoc): Promise<DocRefHealth> {
  const refs = parseRefs(doc)
  if (refs.length === 0) {
    return { refs: [], anyValid: true, allBroken: false, brokenCount: 0 }
  }
  const statuses = await Promise.all(refs.map((r) => verifyRef(worktree, r)))
  const brokenCount = statuses.filter((s) => !s.valid).length
  return {
    refs: statuses,
    anyValid: brokenCount < statuses.length,
    allBroken: brokenCount === statuses.length,
    brokenCount,
  }
}

/**
 * Git-aware check: is the file currently tracked? Useful to distinguish
 * "file not there because I moved it" from "file is untracked garbage".
 * Not currently used by the injector but exposed for future features.
 */
export async function isTracked(worktree: string, relPath: string): Promise<boolean> {
  const result = await git(["ls-files", "--error-unmatch", relPath], { cwd: worktree })
  return result.exitCode === 0
}
