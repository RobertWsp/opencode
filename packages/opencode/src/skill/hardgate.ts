import z from "zod"

export namespace HardGate {
  export const Gate = z.object({
    condition: z.string(),
    blocked: z.array(z.string()),
  })
  export type Gate = z.infer<typeof Gate>

  const PATTERN = /<HARD-GATE>([\s\S]*?)<\/HARD-GATE>/g

  export function parse(content: string): Gate[] {
    const result: Gate[] = []
    for (const match of content.matchAll(PATTERN)) {
      const body = match[1]
      const line = body.match(/^blocked:\s*(.+)$/m)
      if (!line) continue
      const blocked = line[1].split(",").map((s) => s.trim()).filter(Boolean)
      const condition = body.replace(/^blocked:\s*.+$/m, "").trim()
      result.push({ condition, blocked })
    }
    return result
  }

  export function check(gates: Gate[], tools: string[]): Gate | undefined {
    return gates.find((gate) => gate.blocked.some((b) => tools.includes(b)))
  }

  export function enforce(gates: Gate[]): Array<{ permission: string; pattern: string; action: "deny" }> {
    return gates.flatMap((gate) => gate.blocked.map((tool) => ({ permission: tool, pattern: "*", action: "deny" as const })))
  }

  export function format(gates: Gate[]): string {
    if (gates.length === 0) return ""
    const items = gates.map(
      (gate) => `<hard-gate>\nblocked: ${gate.blocked.join(", ")}\n${gate.condition}\n</hard-gate>`,
    )
    return `<hard-gates>\n${items.join("\n")}\n</hard-gates>`
  }
}
