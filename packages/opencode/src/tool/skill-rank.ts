import type { Skill } from "../skill"

export type ScoredSkill = {
  skill: Skill.Info
  score: number
}

export function rank(skills: Skill.Info[], signals: string[] = [], query?: string): ScoredSkill[] {
  const q = query?.toLowerCase() ?? ""
  const sigs = signals.map((s) => s.toLowerCase())

  const scored = skills.map((skill) => {
    const name = skill.name.toLowerCase()
    const desc = skill.description.toLowerCase()
    let score = 0

    if (q) {
      if (name.includes(q)) score += 3
      if (desc.includes(q)) score += 1
    }

    for (const sig of sigs) {
      if (name.includes(sig) || desc.includes(sig)) {
        score += 2
        break
      }
    }

    return { skill, score }
  })

  return scored.sort((a, b) => b.score - a.score)
}
