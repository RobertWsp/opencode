import { describe, expect, test } from "bun:test"
import {
  extractTaskRefs,
  enrichWithTaskRefs,
} from "../../../src/plugin/obsidian-memory/task-linker"

describe("extractTaskRefs", () => {
  test("finds PROJ-123 pattern in text", () => {
    expect(extractTaskRefs("working on PROJ-123 today")).toEqual(["PROJ-123"])
  })

  test("finds #456 pattern", () => {
    expect(extractTaskRefs("fixes #456 in the code")).toEqual(["#456"])
  })

  test("finds multiple refs in one text", () => {
    const refs = extractTaskRefs("PROJ-123 and PROJ-456 and #789")
    expect(refs).toContain("PROJ-123")
    expect(refs).toContain("PROJ-456")
    expect(refs).toContain("#789")
    expect(refs.length).toBe(3)
  })

  test("returns empty for no refs", () => {
    expect(extractTaskRefs("no task references here")).toEqual([])
    expect(extractTaskRefs("")).toEqual([])
  })

  test("deduplicates refs", () => {
    expect(extractTaskRefs("PROJ-123 and then PROJ-123 again")).toEqual(["PROJ-123"])
  })

  test("handles various formats: ORG-123 and JIRA-1 match, feat-456 does not", () => {
    const refs = extractTaskRefs("ORG-123 and feat-456 and JIRA-1")
    expect(refs).toContain("ORG-123")
    expect(refs).toContain("JIRA-1")
    expect(refs).not.toContain("feat-456")
  })
})

describe("enrichWithTaskRefs", () => {
  test("adds task field to meta when refs found in summary", () => {
    const result = enrichWithTaskRefs({ title: "some note" }, "fixing PROJ-123 today")
    expect(result.task).toBe("PROJ-123")
  })

  test("returns meta unchanged when no refs found", () => {
    const meta = { title: "some note" }
    const result = enrichWithTaskRefs(meta, "no task refs here")
    expect(result.task).toBeUndefined()
    expect(result.title).toBe("some note")
  })

  test("merges with existing task field", () => {
    const result = enrichWithTaskRefs({ title: "note", task: "PROJ-100" }, "also relates to PROJ-123")
    expect(result.task).toContain("PROJ-100")
    expect(result.task).toContain("PROJ-123")
  })

  test("deduplicates when ref already in task field", () => {
    const result = enrichWithTaskRefs({ title: "note", task: "PROJ-123" }, "PROJ-123 is the issue")
    expect(result.task).toBe("PROJ-123")
  })

  test("does not mutate original meta", () => {
    const meta = { title: "note" }
    enrichWithTaskRefs(meta, "PROJ-123 fix")
    expect((meta as Record<string, string>).task).toBeUndefined()
  })
})
