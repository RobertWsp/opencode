/**
 * Integration tests for the ObsidianMemoryPlugin entry point.
 *
 * These exercise the full hook flow (config → command.execute.before →
 * experimental.chat.system.transform) by invoking the plugin directly with
 * fake PluginInput and minimal stubs. Bypasses the opencode runtime loop
 * which otherwise blocks waiting on LLM IO.
 */
import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { $ } from "bun"
import { ObsidianMemoryPlugin } from "../../../src/plugin/obsidian-memory"

const tempDirs: string[] = []

interface TestContext {
  worktree: string
  vaultPath: string
  client: {
    session: {
      messages: (args: { sessionID: string; limit?: number }) => Promise<{ data: unknown[] }>
    }
  }
}

async function makeContext(opts?: {
  messages?: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
}): Promise<TestContext> {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "omem-int-wt-"))
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "omem-int-vault-"))
  tempDirs.push(worktree, vaultPath)

  await $`git init -q`.cwd(worktree)
  await $`git config user.email t@l`.cwd(worktree)
  await $`git config user.name t`.cwd(worktree)
  await $`git config commit.gpgsign false`.cwd(worktree)
  await $`git remote add origin git@github.com:test/memfork.git`.cwd(worktree)
  await fs.writeFile(path.join(worktree, "README.md"), "# test\n")
  await $`git add README.md`.cwd(worktree)
  await $`git commit -q -m init`.cwd(worktree)

  return {
    worktree,
    vaultPath,
    client: {
      session: {
        messages: async () => ({ data: opts?.messages ?? [] }),
      },
    },
  }
}

async function loadPlugin(ctx: TestContext, memoryConfig: Record<string, unknown> | false) {
  const stubInput = {
    client: ctx.client,
    project: { id: "test" },
    worktree: ctx.worktree,
    directory: ctx.worktree,
    serverUrl: "http://localhost:4096",
    $,
  } as unknown as Parameters<typeof ObsidianMemoryPlugin>[0]
  const hooks = await ObsidianMemoryPlugin(stubInput)
  const cfg: { memory?: unknown; command?: Record<string, unknown> } = {}
  if (memoryConfig !== false) cfg.memory = memoryConfig
  await hooks.config?.(cfg as never)
  return { hooks, cfg }
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("ObsidianMemoryPlugin config hook", () => {
  test("registers /memory command when enabled", async () => {
    const ctx = await makeContext()
    const { cfg } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    expect(cfg.command?.["memory"]).toBeDefined()
    const cmd = cfg.command!["memory"] as { description: string; template: string }
    expect(cmd.description).toContain("memory")
    expect(cmd.template).toBe("memory $ARGUMENTS")
  })

  test("no-op when memory disabled", async () => {
    const ctx = await makeContext()
    const { cfg } = await loadPlugin(ctx, { enabled: false })
    expect(cfg.command?.["memory"]).toBeUndefined()
  })

  test("no-op when memory absent entirely", async () => {
    const ctx = await makeContext()
    const { cfg } = await loadPlugin(ctx, false)
    expect(cfg.command).toBeUndefined()
  })
})

describe("ObsidianMemoryPlugin command.execute.before hook", () => {
  test("ignores non-memory commands", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    const output = { parts: [{ type: "text", text: "unchanged" }] }
    await hooks["command.execute.before"]!(
      { command: "other", sessionID: "ses_x", arguments: "" } as never,
      output as never,
    )
    expect(output.parts[0].text).toBe("unchanged")
  })

  test("/memory list replaces parts with empty-vault message", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    const output = { parts: [{ type: "text", text: "memory list" }] }
    await hooks["command.execute.before"]!(
      { command: "memory", sessionID: "ses_x", arguments: "list" } as never,
      output as never,
    )
    expect(output.parts).toHaveLength(1)
    expect(output.parts[0].text).toContain("[memory]")
    expect(output.parts[0].text).toContain("no memories yet")
  })

  test("/memory save creates a note file and reports path", async () => {
    const ctx = await makeContext({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "what is 2+2" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "4" }] },
      ],
    })
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    const output = { parts: [{ type: "text", text: "memory save math-q" }] }
    await hooks["command.execute.before"]!(
      { command: "memory", sessionID: "ses_x", arguments: "save math-q" } as never,
      output as never,
    )
    expect(output.parts[0].text).toContain("saved →")
    // Verify file exists
    const entries = await findAllFiles(path.join(ctx.vaultPath, "opencode"))
    const notes = entries.filter((e) => e.includes("/notes/") && e.endsWith(".md"))
    expect(notes).toHaveLength(1)
    const content = await fs.readFile(notes[0], "utf8")
    expect(content).toContain("title: math-q")
    expect(content).toContain("what is 2+2")
    expect(content).toContain("4")
  })

  test("/memory show returns path-traversal error", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    const output = { parts: [{ type: "text", text: "memory show ../../etc/passwd" }] }
    await hooks["command.execute.before"]!(
      { command: "memory", sessionID: "ses_x", arguments: "show ../../etc/passwd" } as never,
      output as never,
    )
    expect(output.parts[0].text).toContain("escapes vault")
  })

  test("strips literal outer quotes from arguments (opencode run quoting)", async () => {
    // opencode run --command escapes args with spaces as "foo bar" literals.
    // Our parser must handle both quoted and unquoted forms.
    const ctx = await makeContext({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "a" }] },
      ],
    })
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    const output = { parts: [{ type: "text", text: "memory" }] }
    await hooks["command.execute.before"]!(
      { command: "memory", sessionID: "ses_x", arguments: '"save quoted-title"' } as never,
      output as never,
    )
    expect(output.parts[0].text).toContain("saved →")
    expect(output.parts[0].text).not.toContain("unknown verb")
  })

  test("/memory with unknown verb returns usage error", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    const output = { parts: [{ type: "text", text: "memory frobnicate" }] }
    await hooks["command.execute.before"]!(
      { command: "memory", sessionID: "ses_x", arguments: "frobnicate" } as never,
      output as never,
    )
    expect(output.parts[0].text).toContain("unknown verb")
  })
})

describe("ObsidianMemoryPlugin experimental.chat.system.transform hook", () => {
  test("does not inject for non-anthropic provider", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    const output = { system: ["existing header"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_x", model: { providerID: "openai", modelID: "gpt-4" } } as never,
      output as never,
    )
    expect(output.system).toEqual(["existing header"])
  })

  test("does not inject when disabled", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: false })
    const output = { system: ["existing header"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_x", model: { providerID: "anthropic", modelID: "claude" } } as never,
      output as never,
    )
    expect(output.system).toEqual(["existing header"])
  })

  test("does not inject when vault is empty", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })
    const output = { system: ["existing header"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_x", model: { providerID: "anthropic", modelID: "claude" } } as never,
      output as never,
    )
    expect(output.system).toEqual(["existing header"])
  })

  test("injects memory block when vault has content", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })

    // Pre-seed: need to discover the scope first by invoking /memory list,
    // which builds the directory structure. Then write the shared file.
    const probeOutput = { parts: [{ type: "text", text: "" }] }
    await hooks["command.execute.before"]!(
      { command: "memory", sessionID: "ses_x", arguments: "save test" } as never,
      probeOutput as never,
    )
    // Now find the repo dir and write a shared file
    const repos = await fs.readdir(path.join(ctx.vaultPath, "opencode", "repos"))
    const sharedPath = path.join(ctx.vaultPath, "opencode", "repos", repos[0], "MEMORY.md")
    await fs.writeFile(sharedPath, "# Repo Memory\n- important fact\n")

    const output = { system: ["existing header"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_x", model: { providerID: "anthropic", modelID: "claude" } } as never,
      output as never,
    )
    expect(output.system).toHaveLength(2)
    expect(output.system[1]).toContain("<memory-block")
    expect(output.system[1]).toContain("important fact")
  })

  test("injection is byte-identical across consecutive calls (cache hit)", async () => {
    const ctx = await makeContext()
    const { hooks } = await loadPlugin(ctx, { enabled: true, vaultPath: ctx.vaultPath })

    // Pre-seed via save (builds directory)
    await hooks["command.execute.before"]!(
      { command: "memory", sessionID: "ses_x", arguments: "save seed" } as never,
      { parts: [{ type: "text" }] } as never,
    )
    const repos = await fs.readdir(path.join(ctx.vaultPath, "opencode", "repos"))
    const sharedPath = path.join(ctx.vaultPath, "opencode", "repos", repos[0], "MEMORY.md")
    await fs.writeFile(sharedPath, "# Repo Memory\n- stable content\n")

    const out1 = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_x", model: { providerID: "anthropic", modelID: "claude" } } as never,
      out1 as never,
    )

    const out2 = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_y", model: { providerID: "anthropic", modelID: "claude" } } as never,
      out2 as never,
    )

    expect(out1.system[0]).toBe(out2.system[0])
  })
})

async function findAllFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    try {
      const entries = await fs.readdir(d, { withFileTypes: true })
      for (const e of entries) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) await walk(full)
        else out.push(full)
      }
    } catch {
      // ignore
    }
  }
  await walk(dir)
  return out
}
