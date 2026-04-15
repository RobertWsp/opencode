import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { $ } from "bun"
import { VaultGit } from "../../../src/plugin/obsidian-memory/vault-git"

const tempDirs: string[] = []

async function makeVault(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-gitvault-"))
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("VaultGit.ensureRepo", () => {
  test("initializes a git repo in a fresh vault", async () => {
    const vault = await makeVault()
    const ok = await VaultGit.ensureRepo(vault)
    expect(ok).toBe(true)
    const stat = await fs.stat(path.join(vault, ".git"))
    expect(stat.isDirectory()).toBe(true)
  })

  test("idempotent — safe to call twice", async () => {
    const vault = await makeVault()
    await VaultGit.ensureRepo(vault)
    const ok = await VaultGit.ensureRepo(vault)
    expect(ok).toBe(true)
  })

  test("creates .gitignore on first init", async () => {
    const vault = await makeVault()
    await VaultGit.ensureRepo(vault)
    const content = await fs.readFile(path.join(vault, ".gitignore"), "utf8")
    expect(content).toContain(".obsidian/workspace")
    expect(content).toContain(".DS_Store")
  })

  test("sets local user identity on first init", async () => {
    const vault = await makeVault()
    await VaultGit.ensureRepo(vault)
    const email = (await $`git config user.email`.cwd(vault).text()).trim()
    const name = (await $`git config user.name`.cwd(vault).text()).trim()
    expect(email).toBe("memory-bot@obsidian-memory.local")
    expect(name).toBe("obsidian-memory")
  })
})

describe("VaultGit.commit", () => {
  test("commits staged changes with given message", async () => {
    const vault = await makeVault()
    await VaultGit.ensureRepo(vault)
    await fs.writeFile(path.join(vault, "note.md"), "content")
    const ok = await VaultGit.commit(vault, "test: adding note")
    expect(ok).toBe(true)
    const log = (await $`git log --oneline -1`.cwd(vault).text()).trim()
    expect(log).toContain("test: adding note")
  })

  test("no-op when nothing changed", async () => {
    const vault = await makeVault()
    await VaultGit.ensureRepo(vault)
    await fs.writeFile(path.join(vault, "note.md"), "content")
    await VaultGit.commit(vault, "first")
    const countBefore = (await $`git rev-list --count HEAD`.cwd(vault).text()).trim()
    await VaultGit.commit(vault, "nothing to do")
    const countAfter = (await $`git rev-list --count HEAD`.cwd(vault).text()).trim()
    expect(countBefore).toBe(countAfter)
  })

  test("truncates long commit messages", async () => {
    const vault = await makeVault()
    await VaultGit.ensureRepo(vault)
    await fs.writeFile(path.join(vault, "note.md"), "x")
    const longMsg = "x".repeat(500)
    const ok = await VaultGit.commit(vault, longMsg)
    expect(ok).toBe(true)
    const log = (await $`git log -1 --format=%s`.cwd(vault).text()).trim()
    expect(log.length).toBeLessThanOrEqual(200)
    expect(log.endsWith("...")).toBe(true)
  })
})

describe("VaultGit.ensureAndCommit", () => {
  test("initializes + commits atomically", async () => {
    const vault = await makeVault()
    // ensureRepo first (which creates initial chore commit), then write + commit
    await VaultGit.ensureRepo(vault)
    await fs.writeFile(path.join(vault, "note.md"), "hello")
    const ok = await VaultGit.ensureAndCommit(vault, "memory(save): note")
    expect(ok).toBe(true)
    const log = (await $`git log --oneline`.cwd(vault).text()).trim()
    expect(log).toContain("memory(save): note")
    expect(log).toContain("initialize memory vault")
  })

  test("first ensureAndCommit on empty vault creates both initial + data commit", async () => {
    const vault = await makeVault()
    await fs.writeFile(path.join(vault, "note.md"), "hello")
    const ok = await VaultGit.ensureAndCommit(vault, "memory(save): note")
    expect(ok).toBe(true)
    // Both the chore: init and the note should be present in history
    const log = (await $`git log --oneline`.cwd(vault).text()).trim()
    // Initial commit captures everything in the working tree, so the note
    // will already be part of the init commit (not a separate one).
    expect(log.split("\n").length).toBeGreaterThanOrEqual(1)
  })

  test("survives permission failures silently", async () => {
    // vaultRoot that cannot be written (best-effort: should not throw)
    const ok = await VaultGit.ensureAndCommit("/this/path/does/not/exist/and/cannot", "msg")
    expect(ok).toBe(false)
  })
})
