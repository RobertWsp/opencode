import type { CaptureEventInput } from "./capture-gate"

/**
 * Detects git state-changing operations from the bash tool output stream.
 * When the agent runs commands like `git checkout -b feature`, `git commit -m`,
 * `git rebase`, `git cherry-pick`, we surface these as first-class
 * `git.event` capture events so the Haiku gate can decide whether a
 * timeline memory ("on 2026-04-15 you branched off main for feature-x") is
 * worth storing.
 *
 * Inspired by Windsurf's Cascade pattern of tracking IDE/terminal actions
 * as context signals.
 *
 * All detection is pure parsing of the bash tool payload — no git probing.
 * Returns null when the command is not interesting enough to enqueue.
 */

export interface GitEventCandidate {
  subcommand: string
  args: string[]
  summary: string
  kind: "episode" | "merge" | "revert"
  hash?: string
  issueRefs?: string[]
  conflicts?: string[]
  filesChanged?: string[]
}

/**
 * Set of git subcommands that are "state-changing" and therefore worth
 * turning into memory candidates. Read-only commands (`status`, `log`,
 * `diff`, `show`, `branch`, `ls-files`, etc.) are ignored.
 */
const INTERESTING_SUBCOMMANDS = new Set([
  "checkout",
  "switch",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "reset",
  "push",
  "pull",
  "clone",
  "tag",
  "stash",
  "worktree",
  "branch",
])

export function extractIssueRefs(message: string): string[] {
  if (!message) return []
  const pattern = /(?:[A-Z]+-\d+|fixes?\s+(#\d+)|closes?\s+(#\d+)|#\d+)/gi
  const refs = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = pattern.exec(message)) !== null) {
    refs.add(m[1] ?? m[2] ?? m[0])
  }
  return [...refs]
}

export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) {
        quote = null
        out.push(current)
        current = ""
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      if (current) {
        out.push(current)
        current = ""
      }
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/**
 * Inspect a bash command + its output and return a git event candidate
 * if it represents a meaningful repo state change. Otherwise null.
 */
export function detectGitEvent(
  command: string,
  stdoutExcerpt?: string,
): GitEventCandidate | null {
  if (!command || typeof command !== "string") return null
  const tokens = splitCommand(command.trim())
  if (tokens.length < 2) return null

  // Find the `git` token (could be after `env`, `sudo`, etc.)
  const gitIdx = tokens.findIndex((t) => t === "git" || t.endsWith("/git"))
  if (gitIdx === -1) return null

  // `git` top-level flags that consume the next token as their argument.
  // We need to skip both when hunting for the subcommand.
  const argTakingGitFlags = new Set(["-C", "-c", "--exec-path", "--git-dir", "--work-tree"])

  // First non-flag token after `git` is the subcommand
  let subcommand = ""
  let i = gitIdx + 1
  while (i < tokens.length) {
    const t = tokens[i]
    if (argTakingGitFlags.has(t)) {
      i += 2 // skip flag + its argument
      continue
    }
    if (t.startsWith("-")) {
      i++
      continue
    }
    subcommand = t
    break
  }
  if (!subcommand || !INTERESTING_SUBCOMMANDS.has(subcommand)) return null

  if (subcommand === "branch") {
    const hasDelete = tokens.some((t) => t === "-d" || t === "-D" || t === "--delete")
    if (!hasDelete) return null
  }

  const args: string[] = []
  let after = false
  for (const t of tokens.slice(gitIdx + 1)) {
    if (!after && t === subcommand) {
      after = true
      continue
    }
    if (after && !t.startsWith("-")) args.push(t)
  }

  const summary = formatSummary(subcommand, args, stdoutExcerpt)
  const kind: "episode" | "merge" | "revert" =
    subcommand === "merge" ? "merge" : subcommand === "revert" ? "revert" : "episode"

  let hash: string | undefined
  if (subcommand === "revert" && args.length > 0) hash = args[0]
  if (subcommand === "commit" && stdoutExcerpt) {
    const brk = stdoutExcerpt.match(/\[([^\]]+)\]/)
    if (brk) {
      const last = brk[1].trim().split(/\s+/).at(-1) ?? ""
      if (/^[a-f0-9]{7,40}$/.test(last)) hash = last
    }
  }

  let issueRefs: string[] | undefined
  if (subcommand === "commit") {
    const msg = args.join(" ") + (stdoutExcerpt ? " " + stdoutExcerpt : "")
    const r = extractIssueRefs(msg)
    if (r.length > 0) issueRefs = r
  }

  const result: GitEventCandidate = { subcommand, args, summary, kind }
  if (hash !== undefined) result.hash = hash
  if (issueRefs !== undefined) result.issueRefs = issueRefs

  if (stdoutExcerpt) {
    const conflicts = extractConflicts(stdoutExcerpt)
    if (conflicts.length > 0) result.conflicts = conflicts
    const changed = extractFilesChanged(stdoutExcerpt)
    if (changed.length > 0) result.filesChanged = changed
  }

  return result
}

function formatSummary(
  subcommand: string,
  args: string[],
  stdoutExcerpt?: string,
): string {
  const tail = args.slice(0, 3).join(" ")
  let base: string
  switch (subcommand) {
    case "checkout":
    case "switch":
      base = `branch switched${tail ? ` → ${tail}` : ""}`
      break
    case "commit":
      base = `commit created`
      break
    case "merge":
      base = `merge${tail ? ` from ${tail}` : ""}`
      break
    case "rebase":
      base = `rebase${tail ? ` onto ${tail}` : ""}`
      break
    case "cherry-pick":
      base = `cherry-pick${tail ? ` ${tail}` : ""}`
      break
    case "revert":
      base = `revert${tail ? ` ${tail}` : ""}`
      break
    case "reset":
      base = `reset${tail ? ` ${tail}` : ""}`
      break
    case "push":
      base = `push${tail ? ` ${tail}` : ""}`
      break
    case "pull":
      base = `pull${tail ? ` ${tail}` : ""}`
      break
    case "clone":
      base = `clone${tail ? ` ${tail}` : ""}`
      break
    case "tag":
      base = `tag${tail ? ` ${tail}` : ""}`
      break
    case "stash":
      base = `stash${tail ? ` ${tail}` : ""}`
      break
    case "worktree":
      base = `worktree${tail ? ` ${tail}` : ""}`
      break
    case "branch":
      base = `branch deleted${tail ? `: ${tail}` : ""}`
      break
    default:
      base = `git ${subcommand}${tail ? ` ${tail}` : ""}`
  }
  if (stdoutExcerpt) {
    const snippet = stdoutExcerpt.trim().split("\n").slice(0, 2).join("; ")
    if (snippet) base += ` [${snippet.slice(0, 100)}]`
  }
  return base.slice(0, 200)
}

/**
 * Build a `CaptureEventInput` from a detected git event. The caller still
 * decides whether to enqueue (respecting debounce, circuit breaker, etc).
 */
export function toCaptureEvent(
  candidate: GitEventCandidate,
  sessionID: string,
): CaptureEventInput {
  const details: Record<string, unknown> = {
    tool: "git",
    subcommand: candidate.subcommand,
    args: candidate.args.join(" "),
  }
  if (candidate.hash !== undefined) details.hash = candidate.hash
  if (candidate.issueRefs !== undefined) details.issueRefs = candidate.issueRefs
  if (candidate.conflicts !== undefined) details.conflicts = candidate.conflicts
  if (candidate.filesChanged !== undefined) details.files = candidate.filesChanged
  if (candidate.kind !== "episode") details.kind = candidate.kind
  return {
    kind: "tool.after",
    sessionID,
    summary: `git:${candidate.subcommand} — ${candidate.summary}`,
    details,
    timestamp: Date.now(),
  }
}

export function extractConflicts(output: string): string[] {
  if (!output) return []
  const files = new Set<string>()
  for (const line of output.split("\n")) {
    const m = line.match(/^CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(.+)/)
    if (m) files.add(m[1].trim())
    const u = line.match(/^UU\s+(.+)/)
    if (u) files.add(u[1].trim())
  }
  return [...files]
}

export function extractFilesChanged(output: string): string[] {
  if (!output) return []
  const files = new Set<string>()
  for (const line of output.split("\n")) {
    const m = line.match(/^\s+(.+?)\s+\|\s+\d+/)
    if (m) files.add(m[1].trim())
    const c = line.match(/^ (create|delete) mode \d+ (.+)/)
    if (c) files.add(c[2].trim())
  }
  return [...files]
}

export function detectGhEvent(
  command: string,
  stdoutExcerpt?: string,
): GitEventCandidate | null {
  if (!command || typeof command !== "string") return null
  const tokens = splitCommand(command.trim())
  if (tokens.length < 3) return null

  const ghIdx = tokens.findIndex((t) => t === "gh" || t.endsWith("/gh"))
  if (ghIdx === -1) return null

  const sub1 = tokens[ghIdx + 1]
  const sub2 = tokens[ghIdx + 2]
  if (!sub1 || !sub2) return null

  if (sub1 === "pr" && sub2 === "create") {
    const title = extractFlag(tokens, "--title") ?? extractFlag(tokens, "-t") ?? "untitled"
    return { subcommand: "pr-create", args: [title], summary: `PR created: ${title}`.slice(0, 200), kind: "episode" }
  }

  if (sub1 === "pr" && sub2 === "merge") {
    const num = tokens[ghIdx + 3] ?? ""
    return { subcommand: "pr-merge", args: [num], summary: `PR merged: ${num}`.slice(0, 200), kind: "merge" }
  }

  if (sub1 === "pr" && sub2 === "checkout") {
    const num = tokens[ghIdx + 3] ?? ""
    return { subcommand: "pr-checkout", args: [num], summary: `PR checked out: ${num}`.slice(0, 200), kind: "episode" }
  }

  if (sub1 === "pr" && sub2 === "close") {
    const num = tokens[ghIdx + 3] ?? ""
    return { subcommand: "pr-close", args: [num], summary: `PR closed: ${num}`.slice(0, 200), kind: "episode" }
  }

  if (sub1 === "issue" && sub2 === "create") {
    const title = extractFlag(tokens, "--title") ?? extractFlag(tokens, "-t") ?? ""
    return { subcommand: "issue-create", args: [title], summary: `Issue created: ${title}`.slice(0, 200), kind: "episode" }
  }

  return null
}

function extractFlag(tokens: string[], flag: string): string | undefined {
  const idx = tokens.indexOf(flag)
  if (idx === -1 || idx + 1 >= tokens.length) return undefined
  return tokens[idx + 1]
}
