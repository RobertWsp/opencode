import { describe, expect, test, beforeEach } from "bun:test"
import path from "path"
import {
  __internal,
  noteSessionIdle,
  shouldReflectNow,
} from "../../../src/plugin/obsidian-memory/reflection-scheduler"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

function makeScope(id = "abc"): Scope {
  const vaultRoot = "/vault"
  const repoSlug = `test-${id}`
  const branchSlug = "main"
  const repoDir = `/vault/opencode/repos/${repoSlug}`
  const branchDir = `${repoDir}/branches/${branchSlug}`
  return {
    vaultRoot,
    basename: "test",
    shortHash: id,
    repoSlug,
    branchRaw: "main",
    branchSlug,
    repoDir,
    repoSharedPath: `${repoDir}/MEMORY.md`,
    branchDir,
    branchSharedPath: `${branchDir}/MEMORY.md`,
    notesDir: `${branchDir}/notes`,
    suggestedDir: `${branchDir}/suggested`,
    systemDir: "/vault/_system",
    systemSharedPath: "/vault/_system/MEMORY.md",
  }
}

const DEFAULT_CFG = {
  model: "claude-haiku-4-5-20251001",
  minHoursSinceLast: 24,
  minSessionsSinceLast: 5,
  minNotesToTrigger: 5,
  maxNotesPerRun: 20,
}

beforeEach(() => {
  __internal.resetState()
})

describe("shouldReflectNow gate", () => {
  test("allows on first run (no state)", () => {
    const scope = makeScope()
    expect(shouldReflectNow(scope, DEFAULT_CFG)).toBe(true)
  })

  test("blocks immediately after a reflection with <5 sessions and <24h", () => {
    const scope = makeScope()
    __internal.stateByScope.set(__internal.scopeKey(scope), {
      lastReflectAt: Date.now(),
      sessionsSinceLast: 0,
    })
    expect(shouldReflectNow(scope, DEFAULT_CFG)).toBe(false)
  })

  test("allows after 24h even with 0 sessions", () => {
    const scope = makeScope()
    __internal.stateByScope.set(__internal.scopeKey(scope), {
      lastReflectAt: Date.now() - 25 * 60 * 60 * 1000,
      sessionsSinceLast: 0,
    })
    expect(shouldReflectNow(scope, DEFAULT_CFG)).toBe(true)
  })

  test("allows after 5 sessions even if <24h elapsed", () => {
    const scope = makeScope()
    __internal.stateByScope.set(__internal.scopeKey(scope), {
      lastReflectAt: Date.now() - 60 * 1000, // 1 min ago
      sessionsSinceLast: 5,
    })
    expect(shouldReflectNow(scope, DEFAULT_CFG)).toBe(true)
  })

  test("session counter is scope-specific", () => {
    const scope1 = makeScope("r1")
    const scope2 = makeScope("r2")
    noteSessionIdle(scope1)
    noteSessionIdle(scope1)
    const key1 = __internal.scopeKey(scope1)
    const key2 = __internal.scopeKey(scope2)
    expect(__internal.stateByScope.get(key1)?.sessionsSinceLast).toBe(2)
    expect(__internal.stateByScope.get(key2)).toBeUndefined()
  })
})

describe("noteSessionIdle", () => {
  test("increments counter on each call", () => {
    const scope = makeScope()
    noteSessionIdle(scope)
    noteSessionIdle(scope)
    noteSessionIdle(scope)
    const key = __internal.scopeKey(scope)
    expect(__internal.stateByScope.get(key)?.sessionsSinceLast).toBe(3)
  })

  test("preserves lastReflectAt across increments", () => {
    const scope = makeScope()
    const reflectTime = Date.now() - 1000
    __internal.stateByScope.set(__internal.scopeKey(scope), {
      lastReflectAt: reflectTime,
      sessionsSinceLast: 1,
    })
    noteSessionIdle(scope)
    const key = __internal.scopeKey(scope)
    expect(__internal.stateByScope.get(key)?.lastReflectAt).toBe(reflectTime)
    expect(__internal.stateByScope.get(key)?.sessionsSinceLast).toBe(2)
  })
})

describe("rewriteScopePaths", () => {
  test("substitutes vaultRoot in every filesystem path", () => {
    const scope = makeScope("xyz")
    const newRoot = "/tmp/worktree-alt"
    const rewritten = __internal.rewriteScopePaths(scope, newRoot)

    expect(rewritten.vaultRoot).toBe(newRoot)
    expect(rewritten.repoDir).toBe(`${newRoot}/opencode/repos/test-xyz`)
    expect(rewritten.repoSharedPath).toBe(`${newRoot}/opencode/repos/test-xyz/MEMORY.md`)
    expect(rewritten.branchDir).toBe(
      `${newRoot}/opencode/repos/test-xyz/branches/main`,
    )
    expect(rewritten.notesDir).toBe(
      `${newRoot}/opencode/repos/test-xyz/branches/main/notes`,
    )
    expect(rewritten.systemSharedPath).toBe(`${newRoot}/_system/MEMORY.md`)
  })

  test("preserves non-path fields", () => {
    const scope = makeScope("foo")
    const rewritten = __internal.rewriteScopePaths(scope, "/new/root")
    expect(rewritten.basename).toBe(scope.basename)
    expect(rewritten.shortHash).toBe(scope.shortHash)
    expect(rewritten.repoSlug).toBe(scope.repoSlug)
    expect(rewritten.branchSlug).toBe(scope.branchSlug)
  })
})
