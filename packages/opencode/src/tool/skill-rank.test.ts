import { describe, it, expect } from "bun:test"
import { rank } from "./skill-rank"
import type { Skill } from "../skill"

describe("skill-rank", () => {
  const mockSkill = (name: string, desc: string): Skill.Info => ({
    name,
    description: desc,
    location: `/mock/${name}`,
    content: "",
  })

  describe("rank()", () => {
    it("returns skills sorted by score descending", () => {
      const skills = [
        mockSkill("git-master", "Git version control"),
        mockSkill("playwright", "Browser automation and testing"),
      ]
      const result = rank(skills, [], "browser")
      expect(result[0].skill.name).toBe("playwright")
      expect(result[1].skill.name).toBe("git-master")
    })

    it("scores keyword match on name with weight 3", () => {
      const skills = [mockSkill("playwright", "Browser automation"), mockSkill("other-tool", "Something else")]
      const result = rank(skills, [], "playwright")
      expect(result[0].score).toBe(3)
      expect(result[1].score).toBe(0)
    })

    it("scores keyword match on description with weight 1", () => {
      const skills = [mockSkill("tool-a", "This is about playwright testing"), mockSkill("tool-b", "Something else")]
      const result = rank(skills, [], "playwright")
      expect(result[0].score).toBe(1)
      expect(result[1].score).toBe(0)
    })

    it("case-insensitive matching on name", () => {
      const skills = [mockSkill("Playwright", "Browser automation")]
      const result = rank(skills, [], "playwright")
      expect(result[0].score).toBe(3)
    })

    it("case-insensitive matching on description", () => {
      const skills = [mockSkill("tool", "This uses PLAYWRIGHT")]
      const result = rank(skills, [], "playwright")
      expect(result[0].score).toBe(1)
    })

    it("scores project signals with weight 2", () => {
      const skills = [mockSkill("playwright", "Browser automation"), mockSkill("other", "Something")]
      const result = rank(skills, ["playwright"], "")
      expect(result[0].score).toBe(2)
      expect(result[1].score).toBe(0)
    })

    it("signal match in description scores weight 2", () => {
      const skills = [mockSkill("tool", "Uses playwright for testing"), mockSkill("other", "Something")]
      const result = rank(skills, ["playwright"], "")
      expect(result[0].score).toBe(2)
      expect(result[1].score).toBe(0)
    })

    it("combines multiple scoring sources", () => {
      const skills = [mockSkill("playwright", "Browser automation and testing")]
      const result = rank(skills, ["playwright"], "playwright")
      // name match (3) + signal match (2) = 5
      expect(result[0].score).toBe(5)
    })

    it("empty query returns all skills with score 0", () => {
      const skills = [mockSkill("tool-a", "Description A"), mockSkill("tool-b", "Description B")]
      const result = rank(skills, [], "")
      expect(result).toHaveLength(2)
      expect(result[0].score).toBe(0)
      expect(result[1].score).toBe(0)
    })

    it("empty signals and query returns all skills with score 0", () => {
      const skills = [mockSkill("tool-a", "Description A"), mockSkill("tool-b", "Description B")]
      const result = rank(skills, [])
      expect(result).toHaveLength(2)
      expect(result.every((s) => s.score === 0)).toBe(true)
    })

    it("returns empty array for empty skills", () => {
      const result = rank([], [], "test")
      expect(result).toHaveLength(0)
    })

    it("performance: ranks 100 skills in < 5ms", () => {
      const skills = Array.from({ length: 100 }, (_, i) => mockSkill(`skill-${i}`, `Description for skill ${i}`))
      const start = performance.now()
      rank(skills, [], "skill-50")
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(5)
    })

    it("maintains skill reference in result", () => {
      const skills = [mockSkill("test", "Test skill")]
      const result = rank(skills, [], "test")
      expect(result[0].skill).toBe(skills[0])
    })

    it("multiple keyword matches accumulate", () => {
      const skills = [mockSkill("playwright", "playwright testing framework")]
      const result = rank(skills, [], "playwright")
      // name match (3) + description match (1) = 4
      expect(result[0].score).toBe(4)
    })

    it("partial word matches count", () => {
      const skills = [mockSkill("playwright-advanced", "Testing")]
      const result = rank(skills, [], "playwright")
      expect(result[0].score).toBe(3)
    })

    it("is pure function with no side effects", () => {
      const skills = [mockSkill("test", "Test")]
      const original = JSON.stringify(skills)
      rank(skills, [], "test")
      expect(JSON.stringify(skills)).toBe(original)
    })
  })
})
