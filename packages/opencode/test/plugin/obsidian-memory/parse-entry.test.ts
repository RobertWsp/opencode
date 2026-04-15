import { describe, expect, test } from "bun:test"
import {
  isValidAt,
  parseLinks,
  parseTags,
  titleToSlug,
  toEntry,
} from "../../../src/plugin/obsidian-memory/parse-entry"
import type { MemoryDoc } from "../../../src/plugin/obsidian-memory/types"

function makeDoc(overrides: Partial<MemoryDoc> & { body?: string; meta?: Record<string, string> }): MemoryDoc {
  return {
    path: "/vault/opencode/repos/test-abc/notes/2026-04-15-my-note.md",
    meta: {},
    body: "",
    mtimeMs: Date.parse("2026-04-15T10:00:00Z"),
    size: 100,
    ...overrides,
  }
}

describe("parseTags", () => {
  test("parses comma-separated tags", () => {
    expect(parseTags("auth,jwt,login")).toEqual(["auth", "jwt", "login"])
  })

  test("lowercases and trims", () => {
    expect(parseTags("  AUTH , JWT  ,login")).toEqual(["auth", "jwt", "login"])
  })

  test("strips leading #", () => {
    expect(parseTags("#auth,#jwt")).toEqual(["auth", "jwt"])
  })

  test("dedupes", () => {
    expect(parseTags("auth,auth,jwt")).toEqual(["auth", "jwt"])
  })

  test("handles empty / undefined", () => {
    expect(parseTags(undefined)).toEqual([])
    expect(parseTags("")).toEqual([])
    expect(parseTags(",,,")).toEqual([])
  })
})

describe("parseLinks", () => {
  test("extracts wikilinks from body", () => {
    const body = "See [[other-note]] and also [[another]]"
    expect(parseLinks(undefined, body)).toEqual(["other-note", "another"])
  })

  test("ignores wikilink aliases", () => {
    const body = "See [[target|display text]]"
    expect(parseLinks(undefined, body)).toEqual(["target"])
  })

  test("parses frontmatter comma list", () => {
    expect(parseLinks("foo,bar,baz", "")).toEqual(["foo", "bar", "baz"])
  })

  test("parses frontmatter JSON array", () => {
    expect(parseLinks('["foo","bar"]', "")).toEqual(["foo", "bar"])
  })

  test("strips [[ ]] wrapping in frontmatter", () => {
    expect(parseLinks("[[foo]],[[bar]]", "")).toEqual(["foo", "bar"])
  })

  test("combines frontmatter + body, dedupes", () => {
    const body = "See [[shared]] and [[body-only]]"
    expect(parseLinks("shared,front-only", body).sort()).toEqual([
      "body-only",
      "front-only",
      "shared",
    ])
  })

  test("handles no links at all", () => {
    expect(parseLinks(undefined, "just prose")).toEqual([])
  })
})

describe("toEntry", () => {
  test("derives kind from memory-kind frontmatter", () => {
    const entry = toEntry(
      makeDoc({
        meta: { "memory-kind": "gotcha", title: "Foo" },
        body: "content",
      }),
    )
    expect(entry.kind).toBe("gotcha")
  })

  test("defaults kind to fact when missing or invalid", () => {
    expect(toEntry(makeDoc({ meta: { title: "T" } })).kind).toBe("fact")
    expect(
      toEntry(makeDoc({ meta: { "memory-kind": "nonsense", title: "T" } })).kind,
    ).toBe("fact")
  })

  test("title falls back to filename", () => {
    const entry = toEntry(
      makeDoc({ path: "/vault/my-cool-note.md", meta: {}, body: "" }),
    )
    expect(entry.title).toBe("my-cool-note")
  })

  test("description falls back to first meaningful line", () => {
    const entry = toEntry(
      makeDoc({
        meta: { title: "T" },
        body: "\n\n# heading\n\nThis is the first line of prose.",
      }),
    )
    expect(entry.description).toBe("heading")
  })

  test("importance clamped to [0,1]", () => {
    expect(toEntry(makeDoc({ meta: { importance: "1.5" } })).importance).toBe(1)
    expect(toEntry(makeDoc({ meta: { importance: "-0.3" } })).importance).toBe(0)
    expect(toEntry(makeDoc({ meta: { importance: "0.7" } })).importance).toBe(0.7)
  })

  test("importance defaults to 0.5 when missing", () => {
    expect(toEntry(makeDoc({ meta: {} })).importance).toBe(0.5)
  })

  test("validFrom defaults to created", () => {
    const entry = toEntry(
      makeDoc({ meta: { created: "2026-01-01T00:00:00Z" }, body: "" }),
    )
    expect(entry.validFrom).toBe("2026-01-01T00:00:00Z")
  })

  test("validUntil parsed; null-ish becomes null", () => {
    expect(toEntry(makeDoc({ meta: { valid_until: "null" } })).validUntil).toBeNull()
    expect(toEntry(makeDoc({ meta: { valid_until: "" } })).validUntil).toBeNull()
    expect(toEntry(makeDoc({ meta: {} })).validUntil).toBeNull()
    const expired = toEntry(
      makeDoc({ meta: { valid_until: "2025-01-01T00:00:00Z" } }),
    )
    expect(expired.validUntil).toBe("2025-01-01T00:00:00Z")
  })

  test("supersededBy strips [[ ]] wrapping", () => {
    expect(
      toEntry(makeDoc({ meta: { superseded_by: "[[new-note]]" } })).supersededBy,
    ).toBe("new-note")
    expect(
      toEntry(makeDoc({ meta: { superseded_by: "plain" } })).supersededBy,
    ).toBe("plain")
    expect(toEntry(makeDoc({ meta: {} })).supersededBy).toBeNull()
  })
})

describe("isValidAt", () => {
  test("always valid when validUntil is null", () => {
    const entry = toEntry(makeDoc({ meta: {} }))
    expect(isValidAt(entry)).toBe(true)
    expect(isValidAt(entry, Date.parse("2030-01-01T00:00:00Z"))).toBe(true)
  })

  test("invalid after validUntil", () => {
    const entry = toEntry(
      makeDoc({ meta: { valid_until: "2026-04-10T00:00:00Z" } }),
    )
    expect(isValidAt(entry, Date.parse("2026-04-11T00:00:00Z"))).toBe(false)
  })

  test("still valid before validUntil", () => {
    const entry = toEntry(
      makeDoc({ meta: { valid_until: "2026-04-20T00:00:00Z" } }),
    )
    // Check at a time AFTER validFrom (derived from mtimeMs = 2026-04-15T10:00:00Z)
    expect(isValidAt(entry, Date.parse("2026-04-16T00:00:00Z"))).toBe(true)
  })

  test("not yet valid before validFrom", () => {
    const entry = toEntry(
      makeDoc({ meta: { valid_from: "2026-05-01T00:00:00Z" } }),
    )
    expect(isValidAt(entry, Date.parse("2026-04-15T00:00:00Z"))).toBe(false)
  })

  test("valid after validFrom", () => {
    const entry = toEntry(
      makeDoc({ meta: { valid_from: "2026-04-01T00:00:00Z" } }),
    )
    expect(isValidAt(entry, Date.parse("2026-04-15T00:00:00Z"))).toBe(true)
  })
})

describe("titleToSlug", () => {
  test("produces kebab-case", () => {
    expect(titleToSlug("My Cool Note")).toBe("my-cool-note")
    expect(titleToSlug("Hello, World!")).toBe("hello-world")
  })

  test("truncates at 50 chars", () => {
    const long = "a".repeat(100)
    expect(titleToSlug(long).length).toBeLessThanOrEqual(50)
  })

  test("falls back to 'note' on empty", () => {
    expect(titleToSlug("")).toBe("note")
    expect(titleToSlug("!!!")).toBe("note")
  })
})
