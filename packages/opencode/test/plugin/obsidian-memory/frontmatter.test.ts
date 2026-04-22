import { describe, expect, test } from "bun:test"
import {
  parseFrontmatter,
  serializeFrontmatter,
} from "../../../src/plugin/obsidian-memory/frontmatter"

describe("parseFrontmatter", () => {
  test("parses basic frontmatter", () => {
    const source = `---
title: Hello
tag: memory
---
body content`
    const result = parseFrontmatter(source)
    expect(result.meta).toEqual({ title: "Hello", tag: "memory" })
    expect(result.body).toBe("body content")
  })

  test("returns empty meta when no frontmatter", () => {
    const result = parseFrontmatter("just a body\nwith multiple lines")
    expect(result.meta).toEqual({})
    expect(result.body).toBe("just a body\nwith multiple lines")
  })

  test("handles CRLF line endings", () => {
    const source = "---\r\ntitle: Hello\r\n---\r\nbody"
    const result = parseFrontmatter(source)
    expect(result.meta.title).toBe("Hello")
    expect(result.body).toBe("body")
  })

  test("strips surrounding quotes from values", () => {
    const source = `---
title: "Hello World"
tag: 'test'
---
body`
    const result = parseFrontmatter(source)
    expect(result.meta.title).toBe("Hello World")
    expect(result.meta.tag).toBe("test")
  })

  test("ignores comment lines", () => {
    const source = `---
# this is a comment
title: Hello
# another comment
tag: memory
---
body`
    const result = parseFrontmatter(source)
    expect(result.meta).toEqual({ title: "Hello", tag: "memory" })
  })

  test("skips lines without colons", () => {
    const source = `---
title: Hello
malformed line
tag: memory
---
body`
    const result = parseFrontmatter(source)
    expect(result.meta).toEqual({ title: "Hello", tag: "memory" })
  })

  test("malformed input does not throw", () => {
    expect(() => parseFrontmatter("---\nno closing delimiter")).not.toThrow()
    expect(() => parseFrontmatter("")).not.toThrow()
    expect(() => parseFrontmatter("---\n---")).not.toThrow()
  })

  test("handles empty body", () => {
    const source = `---
title: Hello
---
`
    const result = parseFrontmatter(source)
    expect(result.body).toBe("")
  })
})

describe("serializeFrontmatter", () => {
  test("round-trips simple values", () => {
    const input = { title: "Hello", tag: "memory" }
    const serialized = serializeFrontmatter(input, "body content")
    const parsed = parseFrontmatter(serialized)
    expect(parsed.meta).toEqual(input)
    expect(parsed.body).toBe("body content")
  })

  test("quotes values with problematic characters", () => {
    const input = { title: "Has: colon", tag: "simple" }
    const serialized = serializeFrontmatter(input, "body")
    expect(serialized).toContain('title: "Has: colon"')
    expect(serialized).toContain("tag: simple")
  })

  test("quotes values with hash", () => {
    const input = { note: "with #hash" }
    const serialized = serializeFrontmatter(input, "body")
    expect(serialized).toContain('note: "with #hash"')
  })

  test("produces valid frontmatter delimiters", () => {
    const serialized = serializeFrontmatter({ a: "b" }, "body")
    expect(serialized.startsWith("---\n")).toBe(true)
    expect(serialized).toContain("\n---\n")
  })
})

describe("YAML arrays (Obsidian compatibility)", () => {
  test("tags serialized as inline YAML array, not comma string", () => {
    const serialized = serializeFrontmatter(
      { tags: "jwt,middleware,debugging", title: "t" },
      "body",
    )
    expect(serialized).toContain("tags: [jwt, middleware, debugging]")
    expect(serialized).not.toContain("tags: jwt,middleware,debugging")
  })

  test("links serialized as inline YAML array", () => {
    const serialized = serializeFrontmatter(
      { links: "note-a,note-b,note-c" },
      "body",
    )
    expect(serialized).toContain("links: [note-a, note-b, note-c]")
  })

  test("aliases serialized as inline YAML array", () => {
    const serialized = serializeFrontmatter({ aliases: "auth,jwt-auth" }, "body")
    expect(serialized).toContain("aliases: [auth, jwt-auth]")
  })

  test("empty list becomes []", () => {
    const serialized = serializeFrontmatter({ tags: "" }, "body")
    expect(serialized).toContain("tags: []")
  })

  test("single item still as array for consistency", () => {
    const serialized = serializeFrontmatter({ tags: "just-one" }, "body")
    expect(serialized).toContain("tags: [just-one]")
  })

  test("list items with problematic chars get quoted inside array", () => {
    const serialized = serializeFrontmatter({ tags: "plain,with space,has:colon" }, "body")
    expect(serialized).toContain("[plain, ")
    expect(serialized).toContain('"with space"')
    expect(serialized).toContain('"has:colon"')
  })

  test("parse inline YAML array back to canonical comma form", () => {
    const source = `---
tags: [jwt, middleware, debugging]
title: Test
---
body`
    const parsed = parseFrontmatter(source)
    expect(parsed.meta.tags).toBe("jwt,middleware,debugging")
    expect(parsed.meta.title).toBe("Test")
  })

  test("parse multiline YAML array", () => {
    const source = `---
tags:
  - jwt
  - middleware
  - debugging
title: Test
---
body`
    const parsed = parseFrontmatter(source)
    expect(parsed.meta.tags).toBe("jwt,middleware,debugging")
    expect(parsed.meta.title).toBe("Test")
  })

  test("parse multiline list with quoted items", () => {
    const source = `---
aliases:
  - plain
  - "with space"
---
body`
    const parsed = parseFrontmatter(source)
    expect(parsed.meta.aliases).toBe("plain,with space")
  })

  test("round-trip tags through YAML array", () => {
    const input = { tags: "a,b,c" }
    const serialized = serializeFrontmatter(input, "body")
    const parsed = parseFrontmatter(serialized)
    expect(parsed.meta.tags).toBe("a,b,c")
  })

  test("parse legacy JSON-array value (backward compat)", () => {
    const source = `---
links: "[\\"note-a\\",\\"note-b\\"]"
---
body`
    const parsed = parseFrontmatter(source)
    expect(parsed.meta.links).toBe("note-a,note-b")
  })

  test("parse legacy comma-string value (backward compat)", () => {
    const source = `---
tags: jwt,middleware
---
body`
    const parsed = parseFrontmatter(source)
    // Legacy form is still accepted — stored as-is (no commas semantic)
    expect(parsed.meta.tags).toContain("jwt")
  })

  test("refs treated as list-key", () => {
    const serialized = serializeFrontmatter(
      { refs: "src/foo.ts:42-58,src/bar.ts" },
      "body",
    )
    expect(serialized).toContain("refs: [")
    // refs values contain `:` so must be quoted inside the array
    expect(serialized).toContain('"src/foo.ts:42-58"')
  })

  test("Obsidian wikilink [[target]] is NOT confused with YAML array", () => {
    const source = `---
superseded_by: [[new-note]]
---
body`
    const parsed = parseFrontmatter(source)
    expect(parsed.meta.superseded_by).toBe("[[new-note]]")
  })

  test("Obsidian wikilink preserved through round-trip", () => {
    const input = { superseded_by: "[[new-note]]" }
    const serialized = serializeFrontmatter(input, "body")
    const parsed = parseFrontmatter(serialized)
    expect(parsed.meta.superseded_by).toBe("[[new-note]]")
  })

  test("round-trip a full memory-note frontmatter", () => {
    const input = {
      type: "memory-note",
      "memory-kind": "gotcha",
      title: "JWT middleware bug",
      repo: "abc123",
      branch: "main",
      created: "2026-04-15T12:30:05Z",
      valid_from: "2026-04-15T12:30:05Z",
      valid_until: "null",
      tags: "jwt,auth,middleware",
      links: "auth-overview,middleware-guide",
      importance: "0.8",
    }
    const serialized = serializeFrontmatter(input, "Body content")
    const parsed = parseFrontmatter(serialized)
    expect(parsed.meta["memory-kind"]).toBe("gotcha")
    expect(parsed.meta.title).toBe("JWT middleware bug")
    expect(parsed.meta.tags).toBe("jwt,auth,middleware")
    expect(parsed.meta.links).toBe("auth-overview,middleware-guide")
    expect(parsed.meta.importance).toBe("0.8")
    // Obsidian-compatibility: tags rendered as array
    expect(serialized).toContain("tags: [jwt, auth, middleware]")
    expect(serialized).toContain("links: [auth-overview, middleware-guide]")
  })

  test("confidence and confidence_score are scalars (NOT in LIST_KEYS)", () => {
    const input = { confidence: "inferred", confidence_score: "0.7" }
    const serialized = serializeFrontmatter(input, "body")
    expect(serialized).toContain("confidence: inferred")
    expect(serialized).toContain("confidence_score: 0.7")
    expect(serialized).not.toContain("[inferred")
    expect(serialized).not.toContain("[0.7")
    const parsed = parseFrontmatter(serialized)
    expect(parsed.meta.confidence).toBe("inferred")
    expect(parsed.meta.confidence_score).toBe("0.7")
  })

  test("confidence parses from hand-written source", () => {
    const source = `---
title: test
confidence: inferred
confidence_score: 0.7
---
body`
    const parsed = parseFrontmatter(source)
    expect(parsed.meta.confidence).toBe("inferred")
    expect(parsed.meta.confidence_score).toBe("0.7")
  })
})
