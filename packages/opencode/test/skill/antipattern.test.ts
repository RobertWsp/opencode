import { describe, test, expect } from "bun:test"
import { Antipattern } from "../../src/skill/antipattern"

describe("Antipattern.DEFAULTS", () => {
  test("has 10 entries", () => {
    expect(Antipattern.DEFAULTS.length).toBe(10)
  })

  test("all entries have required fields", () => {
    for (const e of Antipattern.DEFAULTS) {
      expect(typeof e.pattern).toBe("string")
      expect(typeof e.response).toBe("string")
      expect(["block", "warn"]).toContain(e.severity)
    }
  })
})

describe("Antipattern.format", () => {
  test("produces XML with all default entries", () => {
    const out = Antipattern.format()
    expect(out).toContain("<antipatterns>")
    expect(out).toContain("</antipatterns>")
    expect(out.match(/<antipattern /g)?.length).toBe(10)
  })

  test("includes severity attribute in output", () => {
    const out = Antipattern.format()
    expect(out).toContain('severity="block"')
    expect(out).toContain('severity="warn"')
  })

  test("produces XML with custom entries", () => {
    const custom: Antipattern.Entry[] = [
      { pattern: "My pattern", response: "My response", severity: "warn" },
    ]
    const out = Antipattern.format(custom)
    expect(out).toContain("My pattern")
    expect(out).toContain("My response")
    expect(out.match(/<antipattern /g)?.length).toBe(1)
  })
})

describe("Antipattern.merge", () => {
  test("combines custom with defaults", () => {
    const custom: Antipattern.Entry[] = [
      { pattern: "Custom pattern", response: "Custom response", severity: "block" },
    ]
    const result = Antipattern.merge(custom)
    expect(result.length).toBe(Antipattern.DEFAULTS.length + 1)
    expect(result[0].pattern).toBe("Custom pattern")
  })

  test("custom overrides defaults by pattern match", () => {
    const pattern = Antipattern.DEFAULTS[0].pattern
    const custom: Antipattern.Entry[] = [
      { pattern, response: "Override response", severity: "warn" },
    ]
    const result = Antipattern.merge(custom)
    expect(result.length).toBe(Antipattern.DEFAULTS.length)
    const found = result.find((e) => e.pattern === pattern)
    expect(found?.response).toBe("Override response")
  })

  test("uses provided defaults instead of DEFAULTS", () => {
    const base: Antipattern.Entry[] = [
      { pattern: "Base pattern", response: "Base response", severity: "warn" },
    ]
    const custom: Antipattern.Entry[] = [
      { pattern: "Custom pattern", response: "Custom response", severity: "block" },
    ]
    const result = Antipattern.merge(custom, base)
    expect(result.length).toBe(2)
    expect(result[0].pattern).toBe("Custom pattern")
    expect(result[1].pattern).toBe("Base pattern")
  })
})

describe("Antipattern.fromSkill", () => {
  test("extracts rationalization blocks from content", () => {
    const content = [
      "<rationalization>",
      "<pattern>Do the wrong thing</pattern>",
      "<response>Do the right thing</response>",
      "<severity>block</severity>",
      "</rationalization>",
    ].join("\n")
    const result = Antipattern.fromSkill(content)
    expect(result.length).toBe(1)
    expect(result[0].pattern).toBe("Do the wrong thing")
    expect(result[0].response).toBe("Do the right thing")
    expect(result[0].severity).toBe("block")
  })

  test("returns empty for content without blocks", () => {
    expect(Antipattern.fromSkill("no rationalization here")).toEqual([])
    expect(Antipattern.fromSkill("")).toEqual([])
  })

  test("defaults severity to warn when missing", () => {
    const content = [
      "<rationalization>",
      "<pattern>Some pattern</pattern>",
      "<response>Some response</response>",
      "</rationalization>",
    ].join("\n")
    const result = Antipattern.fromSkill(content)
    expect(result[0].severity).toBe("warn")
  })

  test("handles multiple rationalization blocks", () => {
    const block = (p: string, r: string, s: string) =>
      `<rationalization>\n<pattern>${p}</pattern>\n<response>${r}</response>\n<severity>${s}</severity>\n</rationalization>`
    const content = [block("p1", "r1", "block"), block("p2", "r2", "warn")].join("\n")
    const result = Antipattern.fromSkill(content)
    expect(result.length).toBe(2)
    expect(result[0].pattern).toBe("p1")
    expect(result[1].pattern).toBe("p2")
  })
})
