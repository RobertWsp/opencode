import { promises as fs } from "fs"
import path from "path"
import { git } from "../../util/git"

/**
 * Git integration for the memory vault — lazy `git init`, and commit-after-write
 * for auditability.
 *
 * Every mutation (writeNote, consolidate, delete) is followed by a commit so
 * that `git log` over the vault becomes the agent's learning timeline. Undo
 * is free via `git revert`, and conflicts across Syncthing replicas can be
 * resolved with standard merge tooling.
 *
 * All operations are best-effort: git failures do NOT bubble up, they just
 * skip the commit. Callers should NOT rely on commits for correctness —
 * only for audit.
 */
export namespace VaultGit {
  /**
   * Ensure the vault directory is a git repository. Runs `git init` if not,
   * plus a sane initial .gitignore. Idempotent — safe to call every time.
   */
  export async function ensureRepo(vaultRoot: string): Promise<boolean> {
    try {
      await fs.mkdir(vaultRoot, { recursive: true })
      const gitDir = path.join(vaultRoot, ".git")
      const stat = await fs.stat(gitDir).catch(() => null)
      if (stat && stat.isDirectory()) return true

      const init = await git(["init", "-q", "-b", "main"], { cwd: vaultRoot })
      if (init.exitCode !== 0) return false

      // Seed identity so commits work even when user global config is absent.
      // Using a bot identity makes auto-commits distinguishable from user commits.
      await git(["config", "user.email", "memory-bot@obsidian-memory.local"], { cwd: vaultRoot })
      await git(["config", "user.name", "obsidian-memory"], { cwd: vaultRoot })
      await git(["config", "commit.gpgsign", "false"], { cwd: vaultRoot })

      const gitignorePath = path.join(vaultRoot, ".gitignore")
      const hasIgnore = await fs
        .stat(gitignorePath)
        .then(() => true)
        .catch(() => false)
      if (!hasIgnore) {
        await fs.writeFile(
          gitignorePath,
          [".obsidian/workspace*", ".obsidian/cache", ".trash", ".DS_Store", ""].join("\n"),
          "utf8",
        )
      }
      await commit(vaultRoot, "chore: initialize memory vault")
      return true
    } catch {
      return false
    }
  }

  /**
   * Stage all changes under vaultRoot and commit with the given message.
   * No-op when nothing changed. Returns true on success, false on any error.
   */
  export async function commit(vaultRoot: string, message: string): Promise<boolean> {
    try {
      const add = await git(["add", "-A", "."], { cwd: vaultRoot })
      if (add.exitCode !== 0) return false

      // Fast exit when there is nothing staged — avoids noisy empty commits.
      const diffCached = await git(["diff", "--cached", "--quiet"], { cwd: vaultRoot })
      if (diffCached.exitCode === 0) return true

      const result = await git(
        ["commit", "--no-verify", "--no-gpg-sign", "-m", truncateMessage(message)],
        { cwd: vaultRoot },
      )
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  /**
   * Run ensureRepo + commit in a single call. Idempotent and safe.
   */
  export async function ensureAndCommit(
    vaultRoot: string,
    message: string,
  ): Promise<boolean> {
    const ok = await ensureRepo(vaultRoot)
    if (!ok) return false
    return commit(vaultRoot, message)
  }

  function truncateMessage(msg: string): string {
    const cleaned = msg.replace(/\s+/g, " ").trim()
    if (cleaned.length <= 200) return cleaned
    return cleaned.slice(0, 197) + "..."
  }
}
