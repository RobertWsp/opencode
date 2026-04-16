import { describe, expect, test } from "bun:test"
import { Coverage } from "../../src/session/coverage"

describe("session.coverage.record", () => {
  test("tracks file reads", () => {
    Coverage.record("cov-record-1", "src/foo.ts", 1, 3)
    expect(Coverage.files("cov-record-1")).toContain("src/foo.ts")
    Coverage.clear("cov-record-1")
  })
})

describe("session.coverage.files", () => {
  test("returns list of read files", () => {
    Coverage.record("cov-files-1", "src/a.ts", 0, 5)
    Coverage.record("cov-files-1", "src/b.ts", 0, 5)
    const list = Coverage.files("cov-files-1")
    expect(list).toContain("src/a.ts")
    expect(list).toContain("src/b.ts")
    Coverage.clear("cov-files-1")
  })
})

describe("session.coverage.lines", () => {
  test("returns line numbers for a file", () => {
    Coverage.record("cov-lines-1", "src/foo.ts", 1, 3)
    expect(Coverage.lines("cov-lines-1", "src/foo.ts")).toEqual([1, 2, 3])
    Coverage.clear("cov-lines-1")
  })
})

describe("session.coverage.percentage", () => {
  test("calculates correctly", () => {
    Coverage.record("cov-pct-1", "src/foo.ts", 1, 5)
    expect(Coverage.percentage("cov-pct-1", "src/foo.ts", 10)).toBe(50)
    Coverage.clear("cov-pct-1")
  })

  test("returns 0 when total is 0", () => {
    Coverage.record("cov-pct-2", "src/foo.ts", 1, 5)
    expect(Coverage.percentage("cov-pct-2", "src/foo.ts", 0)).toBe(0)
    Coverage.clear("cov-pct-2")
  })
})

describe("session.coverage.clear", () => {
  test("removes session data", () => {
    Coverage.record("cov-clear-1", "src/foo.ts", 0, 10)
    Coverage.clear("cov-clear-1")
    expect(Coverage.files("cov-clear-1")).toEqual([])
  })
})

describe("session.coverage.format", () => {
  test("returns readable summary", () => {
    Coverage.record("cov-format-1", "src/foo.ts", 1, 10)
    const out = Coverage.format("cov-format-1")
    expect(out).toContain("src/foo.ts")
    expect(out).toContain("10 lines")
    Coverage.clear("cov-format-1")
  })

  test("returns no files read for empty session", () => {
    expect(Coverage.format("cov-format-empty")).toBe("no files read")
  })
})
