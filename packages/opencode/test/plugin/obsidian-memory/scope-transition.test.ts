import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { $ } from "bun"
import { detectScope } from "../../../src/plugin/obsidian-memory/scope"
import {
  ANCHOR_FILENAME,
  createAnchor,
  readAnchor,
  writeAnchor,
} from "../../../src/plugin/obsidian-memory/scope-anchor"

const tempDirs: string[] = []
async function mktmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
async function gitify(dir: string, opts: { remote?: string } = {}) {
  await $`git init -q -b main`.cwd(dir).quiet()
  await $`git config user.email t@t`.cwd(dir).quiet()
  await $`git config user.name t`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  if (opts.remote) {
    await $`git remote add origin ${opts.remote}`.cwd(dir).quiet()
  }
  await fs.writeFile(path.join(dir, "x"), "x")
  await $`git add . && git commit -q -m init`.cwd(dir).quiet()
}
afterAll(async () => {
  for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
})

const VAULT = "/tmp/scope-transition-vault"

describe("scope transition with anchor", () => {
  test("anchor preserves repoSlug when non-git dir becomes git+remote", async () => {
    const dir = await mktmp("trans-A-")
    // 1. Non-git: synthetic scope
    const before = await detectScope({ worktree: dir, vaultPath: VAULT })
    expect(before!.synthetic).toBe(true)
    expect(before!.branchSlug).toBe("_nogit")
    // 2. Write anchor matching the synthetic slug (simulating first save)
    await writeAnchor(dir, createAnchor({ repoSlug: before!.repoSlug }))
    // 3. gitify with remote — natural slug would change
    await gitify(dir, { remote: "git@github.com:foo/bar.git" })
    const after = await detectScope({ worktree: dir, vaultPath: VAULT })
    // 4. Anchor preserves the original repoSlug
    expect(after!.repoSlug).toBe(before!.repoSlug)
    expect(after!.anchored).toBe(true)
    expect(after!.naturalRepoSlug).toBe("bar-" + (after!.naturalRepoSlug?.split("-")[1] ?? ""))
    expect(after!.branchSlug).toBe("main")
  })

  test("anchor survives rm -rf .git in a repo with remote", async () => {
    const dir = await mktmp("trans-B-")
    await gitify(dir, { remote: "git@github.com:foo/proj.git" })
    const before = await detectScope({ worktree: dir, vaultPath: VAULT })
    const pinnedSlug = before!.repoSlug
    expect(pinnedSlug).toMatch(/^proj-[a-f0-9]{6}$/)
    // Anchor written (simulating first save)
    await writeAnchor(dir, createAnchor({ repoSlug: pinnedSlug }))
    // Catastrophic event: user deletes .git
    await fs.rm(path.join(dir, ".git"), { recursive: true })
    // Detection now falls back to synthetic, BUT anchor overrides the slug
    const after = await detectScope({ worktree: dir, vaultPath: VAULT })
    expect(after!.repoSlug).toBe(pinnedSlug)
    expect(after!.anchored).toBe(true)
    expect(after!.branchSlug).toBe("_nogit")
    expect(after!.naturalRepoSlug).not.toBe(pinnedSlug)
  })

  test("anchor is idempotent — detect without change works", async () => {
    const dir = await mktmp("trans-C-")
    await gitify(dir)
    await writeAnchor(dir, createAnchor({ repoSlug: "pinned-123456" }))
    const s1 = await detectScope({ worktree: dir, vaultPath: VAULT })
    const s2 = await detectScope({ worktree: dir, vaultPath: VAULT })
    expect(s1!.repoSlug).toBe("pinned-123456")
    expect(s2!.repoSlug).toBe("pinned-123456")
    expect(s1!.repoSlug).toBe(s2!.repoSlug)
  })

  test("deleting anchor restores natural detection", async () => {
    const dir = await mktmp("trans-D-")
    await gitify(dir, { remote: "git@github.com:foo/bar.git" })
    const natural = await detectScope({ worktree: dir, vaultPath: VAULT })
    await writeAnchor(dir, createAnchor({ repoSlug: "pinned-999999" }))
    const pinned = await detectScope({ worktree: dir, vaultPath: VAULT })
    expect(pinned!.repoSlug).toBe("pinned-999999")
    await fs.unlink(path.join(dir, ANCHOR_FILENAME))
    const after = await detectScope({ worktree: dir, vaultPath: VAULT })
    expect(after!.repoSlug).toBe(natural!.repoSlug)
    expect(after!.anchored).toBeUndefined()
  })

  test("anchor equal to natural repoSlug does NOT mark anchored=true", async () => {
    const dir = await mktmp("trans-E-")
    await gitify(dir, { remote: "git@github.com:foo/same.git" })
    const natural = await detectScope({ worktree: dir, vaultPath: VAULT })
    await writeAnchor(dir, createAnchor({ repoSlug: natural!.repoSlug }))
    const after = await detectScope({ worktree: dir, vaultPath: VAULT })
    // Same slug → no override needed → anchored stays undefined
    expect(after!.anchored).toBeUndefined()
    expect(after!.repoSlug).toBe(natural!.repoSlug)
  })

  test("scope includes worktree field for downstream consumers", async () => {
    const dir = await mktmp("trans-F-")
    const s = await detectScope({ worktree: dir, vaultPath: VAULT })
    // realpath/tmpdir may have a symlink prefix, so compare suffix
    expect(s!.worktree!.endsWith(path.basename(dir))).toBe(true)
  })

  test("invalid anchor JSON falls through to natural detection", async () => {
    const dir = await mktmp("trans-G-")
    await gitify(dir, { remote: "git@github.com:foo/g.git" })
    await fs.writeFile(path.join(dir, ANCHOR_FILENAME), "broken{")
    const s = await detectScope({ worktree: dir, vaultPath: VAULT })
    expect(s!.repoSlug).toMatch(/^g-[a-f0-9]{6}$/)
    expect(s!.anchored).toBeUndefined()
  })
})
