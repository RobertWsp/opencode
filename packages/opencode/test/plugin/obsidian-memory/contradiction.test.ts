import { afterAll, describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import {
  detectContradiction,
  markSuperseded,
} from "../../../src/plugin/obsidian-memory/contradiction"
import type { MemoryDoc, MemoryEntry } from "../../../src/plugin/obsidian-memory/types"

const temps: string[] = []

afterAll(async () => {
  for (const d of temps) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
  }
})

function makeDoc(p: string, meta: Record<string, string>, body: string): MemoryDoc {
  return { path: p, meta, body, mtimeMs: Date.now(), size: body.length }
}

function makeEntry(
  title: string,
  tags: string[],
  body: string,
  opts?: { supersededBy?: string; validUntil?: string },
): MemoryEntry {
  return {
    doc: makeDoc(`/vault/notes/${title}.md`, { title, tags: tags.join(",") }, body),
    kind: "fact",
    title,
    description: body.slice(0, 80),
    tags,
    links: [],
    importance: 0.5,
    created: "2026-01-01T00:00:00.000Z",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: opts?.validUntil ?? null,
    supersededBy: opts?.supersededBy ?? null,
  }
}

describe("detectContradiction", () => {
  test("finds contradiction when new memory conflicts with existing", async () => {
    const entry = makeEntry(
      "redis config",
      ["redis", "config"],
      "redis config changed, no longer uses port 6379, now uses 6380",
    )
    const old = makeEntry(
      "redis config",
      ["redis", "config"],
      "redis uses port 6379 by default",
    )
    const result = await detectContradiction(entry, [old], 0.5)
    expect(result).not.toBeNull()
    expect(result!.title).toBe("redis config")
    expect(result!.path).toBe(old.doc.path)
    expect(result!.similarity).toBeGreaterThan(0.5)
  })

  test("returns null for complementary memories on different topics", async () => {
    const entry = makeEntry(
      "redis lru eviction",
      ["redis", "cache"],
      "configure LRU eviction policy for memory limits",
    )
    const old = makeEntry(
      "postgres index optimization",
      ["postgres", "database"],
      "use partial indexes for filtered queries",
    )
    const result = await detectContradiction(entry, [old])
    expect(result).toBeNull()
  })

  test("returns null when new body has no negation words", async () => {
    const entry = makeEntry(
      "redis config",
      ["redis", "config"],
      "redis uses port 6380 for all connections",
    )
    const old = makeEntry(
      "redis config",
      ["redis", "config"],
      "redis uses port 6379 by default",
    )
    const result = await detectContradiction(entry, [old], 0.5)
    expect(result).toBeNull()
  })

  test("returns null when similarity is below threshold", async () => {
    const entry = makeEntry(
      "redis config",
      ["redis"],
      "redis config changed, no longer default",
    )
    const old = makeEntry(
      "redis config",
      ["redis"],
      "redis default configuration",
    )
    const result = await detectContradiction(entry, [old], 0.99)
    expect(result).toBeNull()
  })

  test("skips already-superseded memories", async () => {
    const entry = makeEntry(
      "redis config",
      ["redis"],
      "redis config changed, no longer valid",
    )
    const old = makeEntry(
      "redis config",
      ["redis"],
      "redis default configuration",
      { supersededBy: "newer-note" },
    )
    const result = await detectContradiction(entry, [old], 0.5)
    expect(result).toBeNull()
  })

  test("skips entries with validUntil set", async () => {
    const entry = makeEntry(
      "redis config",
      ["redis"],
      "redis config changed, no longer valid",
    )
    const old = makeEntry(
      "redis config",
      ["redis"],
      "redis default configuration",
      { validUntil: "2025-01-01T00:00:00.000Z" },
    )
    const result = await detectContradiction(entry, [old], 0.5)
    expect(result).toBeNull()
  })

  test("returns most similar candidate above threshold", async () => {
    const entry = makeEntry(
      "redis config port",
      ["redis"],
      "redis port changed, no longer 6379",
    )
    const close = makeEntry(
      "redis config port",
      ["redis"],
      "redis port is 6379",
    )
    const far = makeEntry(
      "nginx reverse proxy setup",
      ["nginx"],
      "nginx upstream configuration",
    )
    const result = await detectContradiction(entry, [close, far], 0.5)
    expect(result).not.toBeNull()
    expect(result!.title).toBe("redis config port")
  })
})

describe("markSuperseded", () => {
  test("sets valid_until and superseded_by in frontmatter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-contra-"))
    temps.push(dir)
    const p = path.join(dir, "note.md")
    await fs.writeFile(p, "---\ntitle: old note\ntags: redis\n---\nsome body\n")

    const ok = await markSuperseded(p, "new note title")
    expect(ok).toBe(true)

    const src = await fs.readFile(p, "utf8")
    expect(src).toContain("valid_until:")
    expect(src).toContain("superseded_by: new note title")
    expect(src).toContain("some body")
  })

  test("preserves all existing frontmatter fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omem-contra-"))
    temps.push(dir)
    const p = path.join(dir, "note.md")
    await fs.writeFile(
      p,
      "---\ntitle: old note\ntags: redis,cache\nimportance: 0.8\nrefs: src/cache.ts\n---\nbody text\n",
    )

    await markSuperseded(p, "replacement note")

    const src = await fs.readFile(p, "utf8")
    expect(src).toContain("title: old note")
    expect(src).toContain("redis")
    expect(src).toContain("cache")
    expect(src).toContain("importance: 0.8")
    expect(src).toContain("src/cache.ts")
    expect(src).toContain("superseded_by: replacement note")
    expect(src).toContain("valid_until:")
    expect(src).toContain("body text")
  })

  test("returns false when file does not exist", async () => {
    const ok = await markSuperseded("/nonexistent/path/note.md", "new note")
    expect(ok).toBe(false)
  })
})
