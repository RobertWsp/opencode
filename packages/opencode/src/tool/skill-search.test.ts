import { describe, it, expect } from "bun:test"
import { SkillSearchTool } from "./skill-search"

describe("skill_search tool", () => {
  it("should have id skill_search", () => {
    expect(SkillSearchTool.id).toBe("skill_search")
  })

  it("should have description", async () => {
    const init = await SkillSearchTool.init()
    expect(init.description.toLowerCase()).toContain("search")
    expect(init.description.length).toBeGreaterThan(0)
  })

  it("should accept query parameter", async () => {
    const init = await SkillSearchTool.init()
    const params = init.parameters
    const result = params.safeParse({ query: "playwright" })
    expect(result.success).toBe(true)
  })

  it("should reject missing query parameter", async () => {
    const init = await SkillSearchTool.init()
    const params = init.parameters
    const result = params.safeParse({})
    expect(result.success).toBe(false)
  })
})
