import { promises as fs } from "fs"
import path from "path"
import { aggregateStats, readRecent } from "./injection-log"
import { writeNote } from "./vault"
import { VaultGit } from "./vault-git"
import type { Scope } from "./types"

/**
 * Result of running a /memory subcommand. `text` is plain markdown that
 * will replace the prompt parts for the turn; `ok=false` signals user
 * error (invalid args, not found) that should NOT cause a retry/backoff.
 */
export interface CommandResult {
  ok: boolean
  text: string
}

/**
 * `/memory save <title>` — capture the last user/assistant exchange of the
 * session as a new note under the current branch.
 */
export async function save(
  scope: Scope,
  title: string,
  sessionID: string,
  client: { session: { messages: (args: { sessionID: string; limit?: number }) => Promise<unknown> } },
): Promise<CommandResult> {
  if (!title.trim()) {
    return { ok: false, text: "[memory] usage: /memory save <title>" }
  }

  let userText = ""
  let asstText = ""
  try {
    const response = await client.session.messages({ sessionID, limit: 100 })
    const data = extractMessagesArray(response)
    const userMsg = findLastByRole(data, "user")
    const asstMsg = findLastByRole(data, "assistant")
    userText = textOf(userMsg).slice(0, 2000)
    asstText = textOf(asstMsg).slice(0, 4000)
  } catch (err) {
    // If we cannot load session history, save what we can — the title is
    // still useful as a bookmark. Do not fail the whole command.
    userText = `(unable to load history: ${errorMessage(err)})`
  }

  const body = [
    "User asked:",
    userText || "(empty)",
    "",
    "Assistant replied:",
    asstText || "(empty)",
    "",
    "Session: " + sessionID,
  ].join("\n")

  const filepath = await writeNote(scope, { title: title.trim(), body })
  const relpath = path.relative(scope.vaultRoot, filepath)
  return { ok: true, text: `[memory] saved → ${relpath}` }
}

/**
 * `/memory list` — enumerate shared MEMORY.md files and recent notes for
 * the current (repo, branch) scope.
 */
export async function list(scope: Scope): Promise<CommandResult> {
  const lines: string[] = []
  lines.push(`[memory] repo=${scope.shortHash} branch=${scope.branchSlug}`)

  for (const { label, path: p } of [
    { label: "SHARED (repo)  ", path: scope.repoSharedPath },
    { label: "SHARED (branch)", path: scope.branchSharedPath },
  ]) {
    try {
      const st = await fs.stat(p)
      lines.push(`${label}  ${path.relative(scope.vaultRoot, p)}  (${st.size}b)`)
    } catch {
      // missing — skip
    }
  }

  try {
    const entries = await fs.readdir(scope.notesDir)
    const mdFiles = entries.filter((e) => e.endsWith(".md")).sort().reverse()
    for (const entry of mdFiles.slice(0, 50)) {
      const full = path.join(scope.notesDir, entry)
      const st = await fs.stat(full)
      lines.push(`NOTE             ${path.relative(scope.vaultRoot, full)}  (${st.size}b)`)
    }
  } catch {
    // no notes dir yet
  }

  if (lines.length === 1) {
    lines.push("(no memories yet)")
  }

  return { ok: true, text: lines.join("\n") }
}

/**
 * `/memory stats` — aggregate counts and latency over the recent injection log.
 */
export async function stats(_scope: Scope): Promise<CommandResult> {
  const entries = await readRecent(500)
  if (entries.length === 0) {
    return { ok: true, text: "[memory] no log entries yet" }
  }
  const s = aggregateStats(entries)
  const lines: string[] = []
  lines.push("[memory] stats (last 500 events)")
  lines.push(`  injections: ${s.totalInjections}`)
  lines.push(`  cache hit rate: ${(s.cacheHitRate * 100).toFixed(1)}%`)
  lines.push(`  avg block size: ${s.avgBytes} bytes`)
  lines.push(`  captures: ${s.totalCaptures}`)
  lines.push(`  consolidations: ${s.totalConsolidations}`)
  if (s.totalConsolidations > 0) {
    lines.push(
      `  ops: merge=${s.opCounts.merge} rewrite=${s.opCounts.rewrite} promote=${s.opCounts.promote} delete=${s.opCounts.delete}`,
    )
  }
  if (s.byScope.length > 0) {
    lines.push("  by scope:")
    for (const row of s.byScope.slice(0, 5)) {
      lines.push(`    ${row.scope}: ${row.injections} injections / ${row.captures} captures`)
    }
  }
  return { ok: true, text: lines.join("\n") }
}

/**
 * `/memory suggested` — list pending suggestions awaiting approval.
 */
export async function suggested(scope: Scope): Promise<CommandResult> {
  try {
    const entries = await fs.readdir(scope.suggestedDir)
    const mdFiles = entries.filter((e) => e.endsWith(".md")).sort()
    if (mdFiles.length === 0) {
      return { ok: true, text: "[memory] no pending suggestions" }
    }
    const lines: string[] = [
      `[memory] ${mdFiles.length} pending suggestion(s) — use /memory approve <id> or /memory reject <id>`,
    ]
    for (const name of mdFiles) {
      const full = path.join(scope.suggestedDir, name)
      const content = await fs.readFile(full, "utf8").catch(() => "")
      const titleMatch = content.match(/^title:\s*(.+)$/m)
      const title = titleMatch ? titleMatch[1].trim() : name
      const impMatch = content.match(/^importance:\s*(.+)$/m)
      const importance = impMatch ? impMatch[1].trim() : ""
      lines.push(`  - ${name}  ★${importance}  ${title}`)
    }
    return { ok: true, text: lines.join("\n") }
  } catch {
    return { ok: true, text: "[memory] no pending suggestions" }
  }
}

/**
 * `/memory approve <filename>` — promote a suggested capture from
 * suggested/ to notes/ and create a git commit.
 */
export async function approve(scope: Scope, filename: string): Promise<CommandResult> {
  if (!filename.trim()) {
    return { ok: false, text: "[memory] usage: /memory approve <filename>" }
  }
  const cleanName = path.basename(filename.trim())
  const src = path.join(scope.suggestedDir, cleanName)
  const dest = path.join(scope.notesDir, cleanName)
  const exists = await fs
    .stat(src)
    .then((s) => s.isFile())
    .catch(() => false)
  if (!exists) {
    return { ok: false, text: `[memory] not found: ${cleanName}` }
  }
  await fs.mkdir(scope.notesDir, { recursive: true })
  await fs.rename(src, dest)
  const relpath = path.relative(scope.vaultRoot, dest)
  await VaultGit.ensureAndCommit(
    scope.vaultRoot,
    `memory(approve): promoted suggestion ${cleanName} [${relpath}]`,
  )
  return { ok: true, text: `[memory] approved → ${relpath}` }
}

/**
 * `/memory reject <filename>` — delete a suggested capture from suggested/.
 * No git commit because the file was never committed in the first place.
 */
export async function reject(scope: Scope, filename: string): Promise<CommandResult> {
  if (!filename.trim()) {
    return { ok: false, text: "[memory] usage: /memory reject <filename>" }
  }
  const cleanName = path.basename(filename.trim())
  const src = path.join(scope.suggestedDir, cleanName)
  const exists = await fs
    .stat(src)
    .then((s) => s.isFile())
    .catch(() => false)
  if (!exists) {
    return { ok: false, text: `[memory] not found: ${cleanName}` }
  }
  await fs.unlink(src)
  return { ok: true, text: `[memory] rejected ${cleanName}` }
}

/**
 * `/memory show <relPath>` — read a memory file, rejecting any path that
 * escapes the vault root (guard against `../` traversal).
 */
export async function show(scope: Scope, relPath: string): Promise<CommandResult> {
  if (!relPath.trim()) {
    return { ok: false, text: "[memory] usage: /memory show <path>" }
  }
  const resolved = path.resolve(scope.vaultRoot, relPath.trim())
  const rootWithSep = scope.vaultRoot.endsWith(path.sep)
    ? scope.vaultRoot
    : scope.vaultRoot + path.sep
  if (!resolved.startsWith(rootWithSep) && resolved !== scope.vaultRoot) {
    return { ok: false, text: "[memory] path escapes vault root" }
  }
  try {
    const content = await fs.readFile(resolved, "utf8")
    return { ok: true, text: "[memory] " + relPath + "\n\n" + content }
  } catch (err) {
    return { ok: false, text: `[memory] not found: ${errorMessage(err)}` }
  }
}

// --- helpers ---

function extractMessagesArray(raw: unknown): Array<{ info: unknown; parts: unknown[] }> {
  // SDK shape: {data: [{info, parts}]} or just an array depending on call mode
  if (!raw) return []
  if (Array.isArray(raw)) return raw as Array<{ info: unknown; parts: unknown[] }>
  const withData = raw as { data?: unknown }
  if (Array.isArray(withData.data)) return withData.data as Array<{ info: unknown; parts: unknown[] }>
  return []
}

function findLastByRole(
  messages: Array<{ info: unknown; parts: unknown[] }>,
  role: "user" | "assistant",
): { info: unknown; parts: unknown[] } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info as { role?: string } | undefined
    if (info?.role === role) return messages[i]
  }
  return undefined
}

function textOf(msg: { info: unknown; parts: unknown[] } | undefined): string {
  if (!msg) return ""
  const parts = Array.isArray(msg.parts) ? msg.parts : []
  const chunks: string[] = []
  for (const part of parts) {
    const p = part as { type?: string; text?: string }
    if (p && p.type === "text" && typeof p.text === "string") {
      chunks.push(p.text)
    }
  }
  return chunks.join("\n")
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
