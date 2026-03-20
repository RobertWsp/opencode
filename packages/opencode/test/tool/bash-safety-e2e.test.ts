import { describe, expect, test } from "bun:test"
import path from "path"
import { BashTool, BashSafetyError } from "../../src/tool/bash"
import { BashSafety } from "../../src/tool/bash-safety"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"

interface AskRequest {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

function ctx(requests: AskRequest[]) {
  return {
    sessionID: "e2e",
    messageID: "",
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
      requests.push(req as AskRequest)
    },
  }
}

async function exec(command: string) {
  const requests: AskRequest[] = []
  let error: Error | undefined
  let output = ""
  let exit: number | null = null
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const bash = await BashTool.init()
      try {
        const result = await bash.execute({ command, description: "e2e test" }, ctx(requests))
        output = result.metadata.output as string
        exit = result.metadata.exit as number | null
      } catch (e) {
        error = e as Error
      }
    },
  })
  return { requests, error, output, exit }
}

function hasSafetyMeta(requests: AskRequest[]) {
  return requests.some((r) => r.metadata?.safety)
}

describe("E2E: BLOCKED commands — must throw BashSafetyError", () => {
  test("git reset --hard HEAD", async () => {
    const r = await exec("git reset --hard HEAD")
    expect(r.error).toBeInstanceOf(BashSafetyError)
    expect(r.error!.message).toContain("BLOCKED")
    expect(r.error!.message).toContain("stash")
  })

  test("rm -rf /", async () => {
    const r = await exec("rm -rf /")
    expect(r.error).toBeInstanceOf(BashSafetyError)
    expect(r.error!.message).toContain("BLOCKED")
  })

  test("rm -rf ~", async () => {
    const r = await exec("rm -rf ~")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("git push --force origin main", async () => {
    const r = await exec("git push --force origin main")
    expect(r.error).toBeInstanceOf(BashSafetyError)
    expect(r.error!.message).toContain("main/master")
  })

  test("git clean -fdx", async () => {
    const r = await exec("git clean -fdx")
    expect(r.error).toBeInstanceOf(BashSafetyError)
    expect(r.error!.message).toContain("dry-run")
  })

  test("dd if=/dev/zero of=/dev/sda", async () => {
    const r = await exec("dd if=/dev/zero of=/dev/sda bs=1M")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })
})

describe("E2E: BYPASS attempts — must NOT pass through as safe", () => {
  test("eval git reset --hard", async () => {
    const r = await exec('eval "git reset --hard"')
    expect(r.error).toBeInstanceOf(BashSafetyError)
    expect(r.error!.message).toContain("eval wrapping")
  })

  test("sh -c rm -rf /", async () => {
    const r = await exec('sh -c "rm -rf /"')
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("bash -c git reset --hard", async () => {
    const r = await exec('bash -c "git reset --hard"')
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("env rm -rf /", async () => {
    const r = await exec("env rm -rf /")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("sudo rm -rf /", async () => {
    const r = await exec("sudo rm -rf /")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("command git reset --hard", async () => {
    const r = await exec("command git reset --hard")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("/usr/bin/git reset --hard", async () => {
    const r = await exec("/usr/bin/git reset --hard HEAD")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("/bin/rm -rf /", async () => {
    const r = await exec("/bin/rm -rf /")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("git push --force=true origin main", async () => {
    const r = await exec("git push --force=true origin main")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })
})

describe("E2E: DANGER commands — must trigger safety ask", () => {
  test("rm -rf ./node_modules", async () => {
    const r = await exec("rm -rf ./node_modules")
    expect(r.error).toBeUndefined()
    expect(hasSafetyMeta(r.requests)).toBe(true)
  })

  test("git rebase main", async () => {
    const r = await exec("git rebase main")
    expect(r.error).toBeUndefined()
    expect(hasSafetyMeta(r.requests)).toBe(true)
  })

  test("git push --force origin feature/test", async () => {
    const r = await exec("git push --force origin feature/test")
    expect(r.error).toBeUndefined()
    expect(hasSafetyMeta(r.requests)).toBe(true)
  })

  test("git branch -D old-branch", async () => {
    const r = await exec("git branch -D old-branch")
    expect(r.error).toBeUndefined()
    expect(hasSafetyMeta(r.requests)).toBe(true)
  })

  test("chmod 755 file.sh", async () => {
    const r = await exec("chmod 755 file.sh")
    expect(r.error).toBeUndefined()
    expect(hasSafetyMeta(r.requests)).toBe(true)
  })

  test("npm publish", async () => {
    const r = await exec("npm publish")
    expect(r.error).toBeUndefined()
    expect(hasSafetyMeta(r.requests)).toBe(true)
  })
})

describe("E2E: SAFE commands — must execute normally, no safety metadata", () => {
  test("echo hello", async () => {
    const r = await exec("echo 'hello safety test'")
    expect(r.error).toBeUndefined()
    expect(r.exit === 0).toBe(true)
    expect(r.output).toContain("hello safety test")
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })

  test("git status", async () => {
    const r = await exec("git status")
    expect(r.error).toBeUndefined()
    expect(r.exit === 0).toBe(true)
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })

  test("git log --oneline", async () => {
    const r = await exec("git log --oneline -3")
    expect(r.error).toBeUndefined()
    expect(r.exit === 0).toBe(true)
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })

  test("ls -la", async () => {
    const r = await exec("ls -la")
    expect(r.error).toBeUndefined()
    expect(r.exit === 0).toBe(true)
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })

  test("git stash", async () => {
    const r = await exec("git stash")
    expect(r.error).toBeUndefined()
    expect(r.exit === 0).toBe(true)
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })

  test("git diff", async () => {
    const r = await exec("git diff")
    expect(r.error).toBeUndefined()
    expect(r.exit === 0).toBe(true)
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })

  test("git reset --soft HEAD~1 is safe", async () => {
    const r = await exec("git reset --soft HEAD~1")
    expect(r.error).toBeUndefined()
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })

  test("rm single file without -r is safe", async () => {
    const r = await exec("rm -f nonexistent.tmp")
    expect(r.error).toBeUndefined()
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })

  test("multi-command: echo && git status", async () => {
    const r = await exec("echo ok && git status")
    expect(r.error).toBeUndefined()
    expect(r.exit === 0).toBe(true)
    expect(hasSafetyMeta(r.requests)).toBe(false)
  })
})

describe("E2E: mixed safe + blocked in multi-command", () => {
  test("echo hello && git reset --hard — blocked wins", async () => {
    const r = await exec("echo hello && git reset --hard HEAD")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })

  test("git status && rm -rf / — blocked wins", async () => {
    const r = await exec("git status && rm -rf /")
    expect(r.error).toBeInstanceOf(BashSafetyError)
  })
})
