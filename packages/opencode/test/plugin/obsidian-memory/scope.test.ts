import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { $ } from "bun"
import {
  canonicalizeLocal,
  canonicalizeRemote,
  deriveBasename,
  detectScope,
} from "../../../src/plugin/obsidian-memory/scope"

async function makeRepo(opts: { remote?: string; branch?: string; detached?: boolean }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-scope-"))
  await $`git init -q`.cwd(dir)
  await $`git config user.email test@local`.cwd(dir)
  await $`git config user.name test`.cwd(dir)
  await $`git config commit.gpgsign false`.cwd(dir)
  if (opts.remote) {
    await $`git remote add origin ${opts.remote}`.cwd(dir)
  }
  await fs.writeFile(path.join(dir, "README.md"), "# test\n")
  await $`git add README.md`.cwd(dir)
  await $`git commit -q -m init`.cwd(dir)
  if (opts.branch && opts.branch !== "main" && opts.branch !== "master") {
    await $`git checkout -q -b ${opts.branch}`.cwd(dir)
  }
  if (opts.detached) {
    const sha = (await $`git rev-parse HEAD`.cwd(dir).text()).trim()
    await $`git checkout -q ${sha}`.cwd(dir)
  }
  return dir
}

const tempDirs: string[] = []
async function track(p: Promise<string>) {
  const dir = await p
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("detectScope", () => {
  test("returns null when vaultPath is missing", async () => {
    const dir = await track(makeRepo({ remote: "git@github.com:foo/bar.git" }))
    const result = await detectScope({ worktree: dir, vaultPath: undefined })
    expect(result).toBeNull()
  })

  test("returns synthetic scope when worktree is not a git repo (default)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-nogit-"))
    tempDirs.push(dir)
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result).not.toBeNull()
    expect(result!.synthetic).toBe(true)
    expect(result!.branchSlug).toBe("_nogit")
    expect(result!.branchRaw).toBe("")
    expect(result!.shortHash).toHaveLength(6)
    expect(result!.repoSlug).toMatch(/^omem-nogit-[a-z0-9-]+-[a-f0-9]{6}$/)
  })

  test("synthetic scope is stable for the same directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-nogit-stable-"))
    tempDirs.push(dir)
    const r1 = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    const r2 = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(r1!.repoSlug).toBe(r2!.repoSlug)
    expect(r1!.shortHash).toBe(r2!.shortHash)
  })

  test("synthetic scopes for different dirs have different slugs", async () => {
    const a = await fs.mkdtemp(path.join(os.tmpdir(), "omem-nogit-a-"))
    const b = await fs.mkdtemp(path.join(os.tmpdir(), "omem-nogit-b-"))
    tempDirs.push(a, b)
    const r1 = await detectScope({ worktree: a, vaultPath: "/tmp/vault" })
    const r2 = await detectScope({ worktree: b, vaultPath: "/tmp/vault" })
    expect(r1!.repoSlug).not.toBe(r2!.repoSlug)
  })

  test("OBSIDIAN_MEMORY_REQUIRE_GIT=1 restores strict behavior (null)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-nogit-strict-"))
    tempDirs.push(dir)
    const prev = process.env.OBSIDIAN_MEMORY_REQUIRE_GIT
    process.env.OBSIDIAN_MEMORY_REQUIRE_GIT = "1"
    try {
      const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
      expect(result).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.OBSIDIAN_MEMORY_REQUIRE_GIT
      else process.env.OBSIDIAN_MEMORY_REQUIRE_GIT = prev
    }
  })

  test("git repos still return non-synthetic scope", async () => {
    const dir = await track(makeRepo({ remote: "git@github.com:foo/bar.git" }))
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result!.synthetic).toBeUndefined()
    expect(result!.branchSlug).not.toBe("_nogit")
  })

  test("slugs a repo with remote URL deterministically", async () => {
    const dir = await track(makeRepo({ remote: "git@github.com:foo/bar.git" }))
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result).not.toBeNull()
    expect(result!.basename).toBe("bar")
    expect(result!.shortHash).toHaveLength(6)
    expect(result!.repoSlug).toBe(`bar-${result!.shortHash}`)
    // Deterministic: same remote → same hash
    const result2 = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result2!.shortHash).toBe(result!.shortHash)
  })

  test("strips .git suffix from basename", async () => {
    const dir = await track(makeRepo({ remote: "https://example.com/foo/my-repo.git" }))
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result!.basename).toBe("my-repo")
  })

  test("falls back to topLevel when remote is absent", async () => {
    const dir = await track(makeRepo({}))
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result).not.toBeNull()
    expect(result!.basename).toMatch(/^omem-scope-[a-z0-9-]+$/)
  })

  test("sanitizes branch with slashes", async () => {
    const dir = await track(makeRepo({ remote: "git@github.com:foo/bar.git", branch: "feature/new-thing" }))
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result!.branchSlug).toBe("feature-new-thing-f97b")
  })

  test("caps branch slug at 60 chars", async () => {
    const longBranch = "feature/" + "a".repeat(100)
    const dir = await track(makeRepo({ remote: "git@github.com:foo/bar.git", branch: longBranch }))
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result!.branchSlug.length).toBeLessThanOrEqual(60)
  })

  test("detached HEAD gets _detached- prefix", async () => {
    const dir = await track(makeRepo({ remote: "git@github.com:foo/bar.git", detached: true }))
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result!.branchSlug.startsWith("_detached-")).toBe(true)
  })

  test("different remotes produce different shortHashes", async () => {
    const dir1 = await track(makeRepo({ remote: "git@github.com:foo/one.git" }))
    const dir2 = await track(makeRepo({ remote: "git@github.com:foo/two.git" }))
    const r1 = await detectScope({ worktree: dir1, vaultPath: "/tmp/vault" })
    const r2 = await detectScope({ worktree: dir2, vaultPath: "/tmp/vault" })
    expect(r1!.shortHash).not.toBe(r2!.shortHash)
  })

  test("same remote produces same shortHash across worktrees", async () => {
    const dir1 = await track(makeRepo({ remote: "git@github.com:foo/same.git" }))
    const dir2 = await track(makeRepo({ remote: "git@github.com:foo/same.git" }))
    const r1 = await detectScope({ worktree: dir1, vaultPath: "/tmp/vault" })
    const r2 = await detectScope({ worktree: dir2, vaultPath: "/tmp/vault" })
    expect(r1!.shortHash).toBe(r2!.shortHash)
  })

  test("expands tilde in vaultPath", async () => {
    const dir = await track(makeRepo({ remote: "git@github.com:foo/bar.git" }))
    const result = await detectScope({ worktree: dir, vaultPath: "~/test-vault" })
    expect(result!.vaultRoot).toBe(path.join(os.homedir(), "test-vault"))
  })

  test("SSH and HTTPS variants of the same repo produce identical shortHash", async () => {
    const dir1 = await track(makeRepo({ remote: "git@github.com:owner/repo.git" }))
    const dir2 = await track(makeRepo({ remote: "https://github.com/owner/repo.git" }))
    const r1 = await detectScope({ worktree: dir1, vaultPath: "/tmp/vault" })
    const r2 = await detectScope({ worktree: dir2, vaultPath: "/tmp/vault" })
    expect(r1!.shortHash).toBe(r2!.shortHash)
    expect(r1!.repoSlug).toBe(r2!.repoSlug)
  })

  test("with and without .git suffix produce identical shortHash", async () => {
    const dir1 = await track(makeRepo({ remote: "https://github.com/owner/repo.git" }))
    const dir2 = await track(makeRepo({ remote: "https://github.com/owner/repo" }))
    const r1 = await detectScope({ worktree: dir1, vaultPath: "/tmp/vault" })
    const r2 = await detectScope({ worktree: dir2, vaultPath: "/tmp/vault" })
    expect(r1!.shortHash).toBe(r2!.shortHash)
  })

  test("credentials in URL do not affect hash", async () => {
    const dir1 = await track(makeRepo({ remote: "https://github.com/owner/repo.git" }))
    const dir2 = await track(makeRepo({ remote: "https://user:token@github.com/owner/repo.git" }))
    const r1 = await detectScope({ worktree: dir1, vaultPath: "/tmp/vault" })
    const r2 = await detectScope({ worktree: dir2, vaultPath: "/tmp/vault" })
    expect(r1!.shortHash).toBe(r2!.shortHash)
  })

  test("builds filesystem paths correctly", async () => {
    const dir = await track(makeRepo({ remote: "git@github.com:foo/bar.git" }))
    const result = await detectScope({ worktree: dir, vaultPath: "/tmp/vault" })
    expect(result!.repoDir).toBe(`/tmp/vault/opencode/repos/${result!.repoSlug}`)
    expect(result!.repoSharedPath).toBe(`${result!.repoDir}/MEMORY.md`)
    expect(result!.branchDir).toBe(`${result!.repoDir}/branches/${result!.branchSlug}`)
    expect(result!.branchSharedPath).toBe(`${result!.branchDir}/MEMORY.md`)
    expect(result!.notesDir).toBe(`${result!.branchDir}/notes`)
  })
})
