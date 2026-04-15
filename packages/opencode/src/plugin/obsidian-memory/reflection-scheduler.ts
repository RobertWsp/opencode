import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { Log } from "../../util/log"
import { git } from "../../util/git"
import { consolidate, type ConsolidateOptions, type ConsolidateResult } from "./consolidator"
import type { Scope } from "./types"
import { VaultGit } from "./vault-git"

const log = Log.create({ service: "plugin.obsidian-memory.reflection" })

/**
 * Temporal-gated consolidation that runs in an isolated git worktree of
 * the vault so the agent's live session can read/write freely without
 * racing against the Sonnet reflection pass.
 *
 * Inspired by Letta's Context Repositories pattern (sleep-time reflection
 * in a worktree with merge-back). Gate rules come from Anthropic's Auto
 * Memory guidance: wait at least 24h OR 5 sessions since last consolidation
 * before spending Sonnet tokens on reorganization.
 *
 * Invariants:
 * - At most ONE reflection runs at a time across the whole plugin instance
 * - Never blocks the main session — errors are silently logged
 * - Merge-back uses squash so the vault timeline stays readable
 * - Worktree is cleaned up in a finally block, even on crash
 */

export interface ReflectionConfig {
  model: string
  minHoursSinceLast: number // default 24
  minSessionsSinceLast: number // default 5
  minNotesToTrigger: number // default 5
  maxNotesPerRun: number // default 20
}

interface ReflectionState {
  lastReflectAt: number
  sessionsSinceLast: number
}

const stateByScope = new Map<string, ReflectionState>()
let globalLock = false

const CONDENSE_THRESHOLD = 5

async function countSessionSummaries(notesDir: string): Promise<number> {
  const entries = await fs.readdir(notesDir).catch(() => [] as string[])
  const results = await Promise.all(
    entries
      .filter((e) => e.endsWith(".md"))
      .map(async (name) => {
        const text = await fs.readFile(path.join(notesDir, name), "utf8").catch(() => "")
        return text.includes("memory-kind: session-summary") ? 1 : 0
      }),
  )
  return results.reduce((a: number, b: number) => a + b, 0)
}

/**
 * Increment the session counter for a scope — called on session.idle.
 * Tracks "sessions since last reflection" for the temporal gate.
 */
export function noteSessionIdle(scope: Scope): void {
  const key = scopeKey(scope)
  const state = stateByScope.get(key) ?? { lastReflectAt: 0, sessionsSinceLast: 0 }
  state.sessionsSinceLast++
  stateByScope.set(key, state)
}

/**
 * Return true if the temporal gate permits a new reflection for this
 * scope right now.
 */
export function shouldReflectNow(scope: Scope, cfg: ReflectionConfig, now = Date.now()): boolean {
  const state = stateByScope.get(scopeKey(scope))
  if (!state) return true // never reflected before
  const hoursSince = (now - state.lastReflectAt) / (1000 * 60 * 60)
  if (hoursSince >= cfg.minHoursSinceLast) return true
  if (state.sessionsSinceLast >= cfg.minSessionsSinceLast) return true
  return false
}

/**
 * Run consolidation in an isolated worktree and merge results back. Returns
 * the ConsolidateResult from the inner call, or null when the gate blocked
 * the run or the global lock was held.
 */
export async function runReflection(
  scope: Scope,
  cfg: ReflectionConfig,
): Promise<ConsolidateResult | null> {
  if (globalLock) {
    log.debug("reflection globally locked, skipping")
    return null
  }
  const summaries = await countSessionSummaries(scope.notesDir)
  if (!shouldReflectNow(scope, cfg) && summaries < CONDENSE_THRESHOLD) {
    log.debug("reflection gate not open", {
      scope: scopeKey(scope),
      state: stateByScope.get(scopeKey(scope)),
      summaries,
    })
    return null
  }

  globalLock = true
  try {
    // Ensure vault is a git repo so worktree add works
    const ok = await VaultGit.ensureRepo(scope.vaultRoot)
    if (!ok) {
      log.info("vault not a git repo, falling back to in-place reflection")
      return await consolidateInPlace(scope, cfg)
    }

    const worktreePath = await createWorktree(scope.vaultRoot)
    if (!worktreePath) {
      log.info("worktree creation failed, falling back to in-place reflection")
      return await consolidateInPlace(scope, cfg)
    }

    try {
      // Translate the scope's vaultRoot to the worktree root. All other
      // paths inside scope remain the same relative layout.
      const worktreeScope = rewriteScopePaths(scope, worktreePath)
      const result = await consolidate(worktreeScope, {
        model: cfg.model,
        minNotesToTrigger: cfg.minNotesToTrigger,
        maxNotesPerRun: cfg.maxNotesPerRun,
      })

      if (result.ok && result.operations.length > 0) {
        const merged = await mergeBack(scope.vaultRoot, worktreePath)
        if (!merged) {
          log.warn("merge-back failed", { ops: result.operations.length })
        }
      }

      if (result.ok) markReflected(scope)
      return result
    } finally {
      await cleanupWorktree(scope.vaultRoot, worktreePath).catch((err) => {
        log.warn("worktree cleanup failed", { worktreePath, error: String(err) })
      })
    }
  } finally {
    globalLock = false
  }
}

async function consolidateInPlace(
  scope: Scope,
  cfg: ReflectionConfig,
): Promise<ConsolidateResult> {
  const result = await consolidate(scope, {
    model: cfg.model,
    minNotesToTrigger: cfg.minNotesToTrigger,
    maxNotesPerRun: cfg.maxNotesPerRun,
  })
  if (result.ok) markReflected(scope)
  return result
}

function markReflected(scope: Scope): void {
  stateByScope.set(scopeKey(scope), {
    lastReflectAt: Date.now(),
    sessionsSinceLast: 0,
  })
}

function scopeKey(scope: Scope): string {
  return `${scope.repoSlug}::${scope.branchSlug}`
}

async function createWorktree(vaultRoot: string): Promise<string | null> {
  const worktreeRoot = path.join(
    os.tmpdir(),
    `omem-reflect-${process.pid}-${Date.now()}`,
  )
  const result = await git(
    ["worktree", "add", "--detach", worktreeRoot, "HEAD"],
    { cwd: vaultRoot },
  )
  if (result.exitCode !== 0) {
    log.debug("git worktree add failed", {
      stderr: result.stderr.toString().slice(0, 200),
    })
    return null
  }
  return worktreeRoot
}

async function mergeBack(vaultRoot: string, worktreePath: string): Promise<boolean> {
  // Worktree is on a detached HEAD; we need to grab its tip SHA and merge.
  const headResult = await git(["rev-parse", "HEAD"], { cwd: worktreePath })
  if (headResult.exitCode !== 0) return false
  const worktreeTip = headResult.text().trim()
  if (!worktreeTip) return false

  // In the worktree, stage all changes and commit (this captures the
  // Sonnet-produced mutations — consolidate() already commits per-op
  // but only if it's a real git dir; a detached worktree is)
  const stageResult = await git(["add", "-A", "."], { cwd: worktreePath })
  if (stageResult.exitCode !== 0) return false
  const wtDiff = await git(["diff", "--cached", "--quiet"], { cwd: worktreePath })
  if (wtDiff.exitCode === 0) {
    // Nothing to commit, nothing to merge
    return true
  }

  const wtCommit = await git(
    [
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      "memory(reflection): sleep-time consolidation pass",
    ],
    { cwd: worktreePath },
  )
  if (wtCommit.exitCode !== 0) return false

  // Now squash-merge the worktree tip into the main vault worktree
  const newTipResult = await git(["rev-parse", "HEAD"], { cwd: worktreePath })
  const newTip = newTipResult.text().trim()

  // Use cherry-pick -n (no commit) from the main vault worktree — this
  // transfers the changes without merge commits, keeping history linear.
  // If main vault is "dirty" from concurrent edits this will fail and
  // we accept the loss (the gate prevents concurrent reflections anyway).
  const cherry = await git(["cherry-pick", "-n", newTip], { cwd: vaultRoot })
  if (cherry.exitCode !== 0) {
    // Abort on conflict — reflection shouldn't clobber user edits
    await git(["cherry-pick", "--abort"], { cwd: vaultRoot }).catch(() => undefined)
    return false
  }
  const diff = await git(["diff", "--cached", "--quiet"], { cwd: vaultRoot })
  if (diff.exitCode === 0) return true
  const commit = await git(
    [
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      "memory(reflection): merged sleep-time consolidation",
    ],
    { cwd: vaultRoot },
  )
  return commit.exitCode === 0
}

async function cleanupWorktree(vaultRoot: string, worktreePath: string): Promise<void> {
  await git(["worktree", "remove", "--force", worktreePath], { cwd: vaultRoot }).catch(
    () => undefined,
  )
  // Best-effort cleanup if git did not remove it
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
}

function rewriteScopePaths(scope: Scope, newVaultRoot: string): Scope {
  const rel = (p: string) => path.relative(scope.vaultRoot, p)
  return {
    ...scope,
    vaultRoot: newVaultRoot,
    repoDir: path.join(newVaultRoot, rel(scope.repoDir)),
    repoSharedPath: path.join(newVaultRoot, rel(scope.repoSharedPath)),
    branchDir: path.join(newVaultRoot, rel(scope.branchDir)),
    branchSharedPath: path.join(newVaultRoot, rel(scope.branchSharedPath)),
    notesDir: path.join(newVaultRoot, rel(scope.notesDir)),
    suggestedDir: path.join(newVaultRoot, rel(scope.suggestedDir)),
    systemDir: path.join(newVaultRoot, rel(scope.systemDir)),
    systemSharedPath: path.join(newVaultRoot, rel(scope.systemSharedPath)),
  }
}

/** Exposed for tests */
export const __internal = {
  stateByScope,
  scopeKey,
  rewriteScopePaths,
  countSessionSummaries,
  CONDENSE_THRESHOLD,
  resetGlobalLock: () => {
    globalLock = false
  },
  resetState: () => {
    stateByScope.clear()
    globalLock = false
  },
}
