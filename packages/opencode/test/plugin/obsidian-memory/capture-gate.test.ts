import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import {
  __internal,
  parseGateResponse,
  CaptureGate,
} from "../../../src/plugin/obsidian-memory/capture-gate"
import type { CaptureEventInput } from "../../../src/plugin/obsidian-memory/capture-gate"
import { parseFrontmatter } from "../../../src/plugin/obsidian-memory/frontmatter"
import type { Scope } from "../../../src/plugin/obsidian-memory/types"

type Queue = {
  events: CaptureEventInput[]
  timer: NodeJS.Timeout | null
  flushing: boolean
  recentHashes?: Map<string, number>
  fileReadCount?: Map<string, number>
}
const makeQueue = (): Queue => ({ events: [], timer: null, flushing: false })

const tempDirs: string[] = []

async function makeTempScope(): Promise<Scope> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omem-cg-"))
  tempDirs.push(vaultRoot)
  const repoSlug = "test-abc"
  const branchSlug = "main"
  const repoDir = path.join(vaultRoot, "opencode", "repos", repoSlug)
  const branchDir = path.join(repoDir, "branches", branchSlug)
  const notesDir = path.join(branchDir, "notes")
  const suggestedDir = path.join(branchDir, "suggested")
  const systemDir = path.join(vaultRoot, "_system")
  await fs.mkdir(notesDir, { recursive: true })
  await fs.mkdir(suggestedDir, { recursive: true })
  return {
    vaultRoot,
    basename: "test",
    shortHash: "abc",
    repoSlug,
    branchRaw: "main",
    branchSlug,
    repoDir,
    repoSharedPath: path.join(repoDir, "MEMORY.md"),
    branchDir,
    branchSharedPath: path.join(branchDir, "MEMORY.md"),
    notesDir,
    suggestedDir,
    systemDir,
    systemSharedPath: path.join(systemDir, "MEMORY.md"),
  }
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("isTrivial pre-filter", () => {
  test("drops trivial read tools", () => {
    for (const tool of ["ls", "glob", "grep", "read", "codesearch", "webfetch"]) {
      expect(
        __internal.isTrivial({
          kind: "tool.after",
          sessionID: "s",
          summary: tool,
          details: { tool },
          timestamp: 0,
        }),
      ).toBe(true)
    }
  })

  test("keeps non-trivial tools", () => {
    for (const tool of ["edit", "write", "bash", "patch", "task"]) {
      expect(
        __internal.isTrivial({
          kind: "tool.after",
          sessionID: "s",
          summary: tool,
          details: { tool },
          timestamp: 0,
        }),
      ).toBe(false)
    }
  })

  test("always keeps session.error", () => {
    expect(
      __internal.isTrivial({
        kind: "session.error",
        sessionID: "s",
        summary: "boom",
        timestamp: 0,
      }),
    ).toBe(false)
  })
})

describe("buildGateUserMessage", () => {
  test("includes user prompt when provided", () => {
    const msg = __internal.buildGateUserMessage(
      [
        {
          kind: "tool.after",
          sessionID: "s",
          summary: "edit src/foo.ts",
          details: { tool: "edit" },
          timestamp: 0,
        },
      ],
      "fix the auth bug",
      [],
    )
    expect(msg).toContain("User's last intent")
    expect(msg).toContain("fix the auth bug")
    expect(msg).toContain("Tool events (1)")
    expect(msg).toContain("edit src/foo.ts")
  })

  test("works without user prompt", () => {
    const msg = __internal.buildGateUserMessage(
      [
        {
          kind: "tool.after",
          sessionID: "s",
          summary: "bash failed",
          timestamp: 0,
        },
      ],
      undefined,
      [],
    )
    expect(msg).not.toContain("User's last intent")
    expect(msg).toContain("Tool events (1)")
    expect(msg).toContain("bash failed")
  })

  test("includes candidates when provided", () => {
    const msg = __internal.buildGateUserMessage(
      [{ kind: "tool.after", sessionID: "s", summary: "x", timestamp: 0 }],
      "doing auth",
      [
        {
          id: "cand_0",
          title: "auth bug gotcha",
          description: "JWT expiry",
          tags: ["auth"],
        },
      ],
    )
    expect(msg).toContain("Existing candidates")
    expect(msg).toContain("cand_0")
    expect(msg).toContain("auth bug gotcha")
    expect(msg).toContain("#auth")
  })
})

describe("parseGateResponse — new 4-op schema", () => {
  test("parses ADD with all fields", () => {
    const raw = JSON.stringify({
      op: "ADD",
      reason: "new gotcha",
      kind: "gotcha",
      title: "jwt-expiry",
      body: "Tokens expire after 1h",
      tags: ["auth", "jwt"],
      links: ["auth overview"],
      importance: 0.8,
    })
    const decision = parseGateResponse(raw)
    expect(decision).not.toBeNull()
    expect(decision!.op).toBe("ADD")
    expect(decision!.kind).toBe("gotcha")
    expect(decision!.tags).toEqual(["auth", "jwt"])
    expect(decision!.links).toEqual(["auth overview"])
    expect(decision!.importance).toBe(0.8)
  })

  test("parses UPDATE with targetId", () => {
    const raw = JSON.stringify({
      op: "UPDATE",
      targetId: "cand_2",
      reason: "adds new info",
      kind: "fact",
      title: "merged",
      body: "new body",
      tags: [],
      links: [],
      importance: 0.6,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.op).toBe("UPDATE")
    expect(decision!.targetId).toBe("cand_2")
  })

  test("parses DELETE with supersedes", () => {
    const raw = JSON.stringify({
      op: "DELETE",
      targetId: "cand_0",
      reason: "obsolete after v5 migration",
      kind: "fact",
      title: "",
      body: "",
      tags: [],
      links: [],
      supersedes: "zustand-v5",
      importance: 0.3,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.op).toBe("DELETE")
    expect(decision!.supersedes).toBe("zustand-v5")
  })

  test("parses NOOP with only op and reason", () => {
    const decision = parseGateResponse(JSON.stringify({ op: "NOOP", reason: "routine" }))
    expect(decision!.op).toBe("NOOP")
    expect(decision!.reason).toBe("routine")
    expect(decision!.tags).toEqual([])
    expect(decision!.links).toEqual([])
  })

  test("back-compat: old save=true → ADD", () => {
    const raw = JSON.stringify({
      save: true,
      reason: "x",
      title: "y",
      body: "z",
      tags: [],
      importance: 0.5,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.op).toBe("ADD")
    expect(decision!.title).toBe("y")
  })

  test("back-compat: old save=false → NOOP", () => {
    const decision = parseGateResponse(JSON.stringify({ save: false, reason: "routine" }))
    expect(decision!.op).toBe("NOOP")
  })

  test("strips markdown code fences", () => {
    const raw = '```json\n{"op": "ADD", "kind": "fact", "title": "t", "body": "b", "tags": [], "links": [], "importance": 0.5}\n```'
    const decision = parseGateResponse(raw)
    expect(decision!.op).toBe("ADD")
  })

  test("returns null on malformed JSON", () => {
    expect(parseGateResponse("not json")).toBeNull()
    expect(parseGateResponse("")).toBeNull()
    expect(parseGateResponse("{incomplete")).toBeNull()
  })

  test("returns null when op is invalid", () => {
    expect(parseGateResponse(JSON.stringify({ op: "UPSERT" }))).toBeNull()
    expect(parseGateResponse(JSON.stringify({}))).toBeNull()
  })

  test("filters non-string tags and links", () => {
    const raw = JSON.stringify({
      op: "ADD",
      kind: "fact",
      title: "t",
      body: "b",
      tags: ["valid", 42, null, "also-valid"],
      links: ["ok", 99, "also-ok"],
      importance: 0.5,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.tags).toEqual(["valid", "also-valid"])
    expect(decision!.links).toEqual(["ok", "also-ok"])
  })

  test("defaults kind to 'fact' when missing or invalid", () => {
    expect(
      parseGateResponse(JSON.stringify({ op: "ADD", title: "t", body: "b" }))!.kind,
    ).toBe("fact")
    expect(
      parseGateResponse(JSON.stringify({ op: "ADD", kind: "nonsense", title: "t", body: "b" }))!
        .kind,
    ).toBe("fact")
  })
})

describe("wikilink validation — links must reference existing vault notes only", () => {
  test("empty vault → message says vault is empty, set links to []", () => {
    const prompt = __internal.buildGateUserMessage(
      [{ kind: "tool.after", sessionID: "s", summary: "edit file", timestamp: 0 }],
      "fix auth",
      [],
      [],  // empty vault
    )
    expect(prompt).not.toContain("Existing candidates")
    expect(prompt).toContain("vault is empty")
    expect(prompt).toContain("links to []")
  })

  test("vault with notes → message includes ALL titles for linking", () => {
    const prompt = __internal.buildGateUserMessage(
      [{ kind: "tool.after", sessionID: "s", summary: "edit file", timestamp: 0 }],
      "fix auth",
      [
        { id: "cand_0", title: "jwt-expiry-gotcha", description: "JWT tokens expire", tags: ["auth"] },
      ],
      ["jwt-expiry-gotcha", "redis-caching-pattern", "zustand-store-patterns"],
    )
    // Candidates section (for UPDATE/DELETE)
    expect(prompt).toContain("Existing candidates (1)")
    expect(prompt).toContain("cand_0")
    // Full vault titles (for linking)
    expect(prompt).toContain("All vault titles (3)")
    expect(prompt).toContain('"jwt-expiry-gotcha"')
    expect(prompt).toContain('"redis-caching-pattern"')
    expect(prompt).toContain('"zustand-store-patterns"')
  })

  test("parseGateResponse keeps links from Haiku output as-is (filtering happens in runGate)", () => {
    const raw = JSON.stringify({
      op: "ADD",
      kind: "gotcha",
      title: "new-note",
      body: "content",
      tags: ["auth"],
      links: ["jwt-expiry-gotcha", "hallucinated-note", "redis-caching-pattern"],
      importance: 0.7,
    })
    const decision = parseGateResponse(raw)
    // Parser preserves all links — filtering is done at the gate level
    expect(decision!.links).toEqual(["jwt-expiry-gotcha", "hallucinated-note", "redis-caching-pattern"])
  })

  test("body from gate response should NOT contain ## Related section", () => {
    const raw = JSON.stringify({
      op: "ADD",
      kind: "fact",
      title: "test-note",
      body: "Just the content without related section",
      tags: [],
      links: ["some-link"],
      importance: 0.5,
    })
    const decision = parseGateResponse(raw)
    expect(decision!.body).not.toContain("## Related")
    expect(decision!.body).not.toContain("[[")
  })

  test("CaptureGate writes note WITHOUT ## Related body section", async () => {
    // This tests the full write path (sans LLM) by simulating what
    // applyOp does: it writes decision.body directly, not fullBody with renderLinksBlock
    const scope = await makeTempScope()
    const { writeNote } = await import("../../../src/plugin/obsidian-memory/vault")

    // Simulate what the gate does after filtering links
    const body = "## Problem\nSome technical gotcha\n\n## Solution\nThe fix"
    const meta = {
      "memory-kind": "gotcha",
      source: "haiku-gate",
      importance: "0.8",
      tags: "auth,jwt",
      links: "jwt-expiry-gotcha",  // only validated links
    }

    const filepath = await writeNote(scope, {
      title: "auth-token-bug",
      body,
      meta,
      skipCommit: true,
    })

    const content = await fs.readFile(filepath, "utf8")
    const parsed = parseFrontmatter(content)

    // Body should NOT contain ## Related or [[wikilinks]]
    expect(parsed.body).not.toContain("## Related")
    expect(parsed.body).not.toContain("[[")

    // Links should be in frontmatter ONLY
    expect(parsed.meta.links).toBeDefined()
    expect(content).toContain("links:")
  })

  test("frontmatter links field stores validated links as YAML array", async () => {
    const scope = await makeTempScope()
    const { writeNote } = await import("../../../src/plugin/obsidian-memory/vault")

    const filepath = await writeNote(scope, {
      title: "test-links-format",
      body: "content",
      meta: { links: "note-a,note-b,note-c" },
      skipCommit: true,
    })

    const content = await fs.readFile(filepath, "utf8")
    // Should be YAML inline array (Obsidian-compatible)
    expect(content).toContain("links: [note-a, note-b, note-c]")
    // Should NOT be comma-separated string
    expect(content).not.toContain("links: note-a,note-b,note-c")
  })

  test("empty links produces empty YAML array, not dangling section", async () => {
    const scope = await makeTempScope()
    const { writeNote } = await import("../../../src/plugin/obsidian-memory/vault")

    const filepath = await writeNote(scope, {
      title: "no-links-note",
      body: "standalone content",
      meta: { links: "" },
      skipCommit: true,
    })

    const content = await fs.readFile(filepath, "utf8")
    expect(content).toContain("links: []")
    expect(content).not.toContain("## Related")
    expect(content).not.toContain("[[")
  })
})

describe("isFilterable — heuristic pre-filters", () => {
  test("Read tool → filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "read src/auth.ts", details: { tool: "Read" }, timestamp: 0 },
        q,
      ),
    ).toBe(true)
  })

  test("grep tool → filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "grep pattern", details: { tool: "grep" }, timestamp: 0 },
        q,
      ),
    ).toBe(true)
  })

  test("glob tool → filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "glob *.ts", details: { tool: "glob" }, timestamp: 0 },
        q,
      ),
    ).toBe(true)
  })

  test("lsp_diagnostics → filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "ran diagnostics", details: { tool: "lsp_diagnostics" }, timestamp: 0 },
        q,
      ),
    ).toBe(true)
  })

  test("lsp_symbols → filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "lsp symbols", details: { tool: "lsp_symbols" }, timestamp: 0 },
        q,
      ),
    ).toBe(true)
  })

  test("lsp_goto_definition → filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "goto def", details: { tool: "lsp_goto_definition" }, timestamp: 0 },
        q,
      ),
    ).toBe(true)
  })

  test("lsp_find_references → filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "find refs", details: { tool: "lsp_find_references" }, timestamp: 0 },
        q,
      ),
    ).toBe(true)
  })

  test("write tool → NOT filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "wrote file", details: { tool: "write" }, timestamp: 0 },
        q,
      ),
    ).toBe(false)
  })

  test("edit tool → NOT filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "edited file", details: { tool: "edit" }, timestamp: 0 },
        q,
      ),
    ).toBe(false)
  })

  test("bash tool → NOT filtered", () => {
    const q = makeQueue()
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "ran command", details: { tool: "bash" }, timestamp: 0 },
        q,
      ),
    ).toBe(false)
  })

  test("same summary within 30min → second call filtered (dedup)", () => {
    const q = makeQueue()
    const ev: CaptureEventInput = {
      kind: "tool.after",
      sessionID: "s",
      summary: "discovered important auth pattern in middleware",
      details: { tool: "edit" },
      timestamp: Date.now(),
    }
    expect(__internal.isFilterable(ev, q)).toBe(false)
    expect(__internal.isFilterable(ev, q)).toBe(true)
  })

  test("same summary after 30+ min window → NOT filtered (expired)", () => {
    const q = makeQueue()
    const hash = __internal.normalizeHash("some repeated analysis content")
    q.recentHashes = new Map([[hash, Date.now() - 31 * 60 * 1000]])
    expect(
      __internal.isFilterable(
        { kind: "tool.after", sessionID: "s", summary: "some repeated analysis content", details: { tool: "edit" }, timestamp: Date.now() },
        q,
      ),
    ).toBe(false)
  })

  test("same file referenced 3+ times → 4th call filtered", () => {
    const q = makeQueue()
    const ev = (n: number): CaptureEventInput => ({
      kind: "tool.after",
      sessionID: "s",
      summary: `edit-${n}`,
      details: { tool: "edit", files: ["src/auth.ts"] },
      timestamp: Date.now(),
    })
    expect(__internal.isFilterable(ev(1), q)).toBe(false)
    expect(__internal.isFilterable(ev(2), q)).toBe(false)
    expect(__internal.isFilterable(ev(3), q)).toBe(false)
    expect(__internal.isFilterable(ev(4), q)).toBe(true)
  })

  test("different files have independent counters", () => {
    const q = makeQueue()
    const ev = (file: string, n: number): CaptureEventInput => ({
      kind: "tool.after",
      sessionID: "s",
      summary: `edit-${file}-${n}`,
      details: { tool: "edit", files: [file] },
      timestamp: Date.now(),
    })
    for (let i = 1; i <= 3; i++) {
      expect(__internal.isFilterable(ev("src/a.ts", i), q)).toBe(false)
    }
    expect(__internal.isFilterable(ev("src/b.ts", 1), q)).toBe(false)
    expect(__internal.isFilterable(ev("src/a.ts", 4), q)).toBe(true)
  })
})
