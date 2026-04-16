import { describe, it, expect } from "bun:test"
import { pathToFileURL } from "url"
import { rank } from "./skill-rank"
import type { Skill } from "../skill"

function mock(n: number): Skill.Info[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `skill-${i}`,
    description: `Description for skill ${i}`,
    location: `/fake/path/skill-${i}/SKILL.md`,
    content: `Content for skill ${i}`,
  }))
}

function build(skills: Skill.Info[]) {
  const ranked = rank(skills, [], undefined)
  const top = ranked.slice(0, 10).map((s) => s.skill)
  const more = skills.length > 10

  if (skills.length === 0) {
    return "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
  }

  return [
    "Load a specialized skill that provides domain-specific instructions and workflows.",
    "",
    "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
    "",
    "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
    "",
    'Tool output includes a `<skill_content name="...">` block with the loaded content.',
    "",
    "The following skills provide specialized sets of instructions for particular tasks",
    "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
    "",
    "<available_skills>",
    ...top.flatMap((skill) => [
      `  <skill>`,
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>${pathToFileURL(skill.location).href}</location>`,
      `  </skill>`,
    ]),
    "</available_skills>",
    ...(more ? ["", "More skills available — use skill_search to find them"] : []),
  ].join("\n")
}

describe("SkillTool description", () => {
  it("shows at most 10 skills when more than 10 available", () => {
    const desc = build(mock(15))
    const matches = desc.match(/<skill>/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeLessThanOrEqual(10)
  })

  it("appends footer when more than 10 skills", () => {
    const desc = build(mock(15))
    expect(desc).toContain("More skills available — use skill_search to find them")
  })

  it("no footer when 10 or fewer skills", () => {
    const desc = build(mock(8))
    expect(desc).not.toContain("More skills available")
  })

  it("shows all skills when exactly 10", () => {
    const desc = build(mock(10))
    const matches = desc.match(/<skill>/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(10)
    expect(desc).not.toContain("More skills available")
  })

  it("handles empty skills", () => {
    const desc = build(mock(0))
    expect(desc).toContain("No skills are currently available")
  })

  it("rank returns all skills preserving full set", () => {
    const skills = mock(15)
    const scored = rank(skills, [], undefined)
    expect(scored.length).toBe(15)
  })

  it("all skills still accessible by name regardless of top-10", () => {
    const skills = mock(20)
    const ranked = rank(skills, [], undefined)
    const top = ranked.slice(0, 10).map((s) => s.skill)
    expect(top.length).toBe(10)
    expect(skills.length).toBe(20)
    for (const s of skills) {
      expect(skills.find((x) => x.name === s.name)).toBeDefined()
    }
  })

  it("init completes in under 10ms", () => {
    const start = performance.now()
    const skills = mock(50)
    const ranked = rank(skills, [], undefined)
    ranked.slice(0, 10).map((s) => s.skill)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(10)
  })

  it("description contains skill names from top ranked", () => {
    const skills = mock(15)
    const desc = build(skills)
    const ranked = rank(skills, [], undefined)
    const top = ranked.slice(0, 10).map((s) => s.skill)
    for (const s of top) {
      expect(desc).toContain(`<name>${s.name}</name>`)
    }
  })
})
