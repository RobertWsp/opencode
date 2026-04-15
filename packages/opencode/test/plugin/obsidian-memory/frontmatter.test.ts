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
