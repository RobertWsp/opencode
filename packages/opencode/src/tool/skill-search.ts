import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"

export const SkillSearchTool = Tool.define("skill_search", async () => {
  const description = "Search for available skills by name or description keyword"

  const parameters = z.object({
    query: z.string().describe("Search query to find skills by name or description"),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const skills = await Skill.all()
      const q = params.query.toLowerCase()

      const matches = skills.filter(
        (skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q),
      )

      const output =
        matches.length === 0
          ? `No skills found matching "${params.query}"`
          : [
              `Found ${matches.length} skill(s) matching "${params.query}":`,
              "",
              ...matches.map((skill) => `- **${skill.name}**: ${skill.description}`),
            ].join("\n")

      return {
        title: `Skill search: "${params.query}"`,
        output,
        metadata: {
          count: matches.length,
        },
      }
    },
  }
})
