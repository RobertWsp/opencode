import z from "zod"

export namespace Antipattern {
  export const Entry = z.object({
    pattern: z.string(),
    response: z.string(),
    severity: z.enum(["block", "warn"]),
  })
  export type Entry = z.infer<typeof Entry>

  export const DEFAULTS: Entry[] = [
    {
      pattern: "Skip TDD just this once",
      response: "Always write tests first. No exceptions.",
      severity: "block",
    },
    {
      pattern: "This is too simple for design",
      response: "Every change deserves a moment of thought.",
      severity: "warn",
    },
    {
      pattern: "I'll reduce scope to make this manageable",
      response: "Never reduce scope without explicit user approval.",
      severity: "block",
    },
    {
      pattern: "I've verified this works",
      response: "Run the actual tests. Self-certification is not verification.",
      severity: "block",
    },
    {
      pattern: "Let me just use `as any` / `@ts-ignore`",
      response: "Fix the type error properly.",
      severity: "block",
    },
    {
      pattern: "I'll delete this failing test",
      response: "Fix the code, not the tests.",
      severity: "block",
    },
    {
      pattern: "This catch block can be empty for now",
      response: "Handle or propagate every error.",
      severity: "warn",
    },
    {
      pattern: "Let me try random changes",
      response: "Diagnose the root cause before changing code.",
      severity: "warn",
    },
    {
      pattern: "I already searched for that",
      response: "Wait for delegated results. No duplicate work.",
      severity: "block",
    },
    {
      pattern: "The context is getting long, let me skip reading",
      response: "Read the code before modifying it.",
      severity: "block",
    },
  ]

  export const REDFLAGS: Entry[] = [
    { pattern: "Code before test", response: "Delete code. Start over with TDD.", severity: "block" },
    { pattern: "Test passes immediately", response: "Test proves nothing. Rewrite to fail first.", severity: "block" },
    { pattern: "Can't explain why test failed", response: "Understanding > doing. Investigate first.", severity: "block" },
    { pattern: "just this once", response: "No exceptions. Follow the process.", severity: "block" },
    { pattern: "This is different because", response: "It's not. Apply the same rigor.", severity: "block" },
    { pattern: "Already spent X hours", response: "Sunk cost fallacy. Delete and restart.", severity: "block" },
    { pattern: "Keep as reference", response: "Delete means delete. No adapting old code.", severity: "block" },
    { pattern: "I'll add tests later", response: "Tests after prove nothing. Write them first.", severity: "block" },
  ]

  export function format(entries?: Entry[]): string {
    const list = entries ?? DEFAULTS
    const items = list.map(
      (e) =>
        `<antipattern severity="${e.severity}">\n<pattern>${e.pattern}</pattern>\n<response>${e.response}</response>\n</antipattern>`,
    )
    return `<antipatterns>\n${items.join("\n")}\n</antipatterns>`
  }

  export function merge(custom: Entry[], defaults?: Entry[]): Entry[] {
    const base = defaults ?? DEFAULTS
    const seen = new Set(custom.map((e) => e.pattern))
    return [...custom, ...base.filter((e) => !seen.has(e.pattern))]
  }

  export function fromSkill(content: string): Entry[] {
    const result: Entry[] = []
    for (const match of content.matchAll(/<rationalization>([\s\S]*?)<\/rationalization>/g)) {
      const body = match[1]
      const p = body.match(/<pattern>([\s\S]*?)<\/pattern>/)
      const r = body.match(/<response>([\s\S]*?)<\/response>/)
      if (!p || !r) continue
      const sev = body.match(/<severity>(block|warn)<\/severity>/)
      result.push({
        pattern: p[1].trim(),
        response: r[1].trim(),
        severity: sev ? (sev[1] as "block" | "warn") : "warn",
      })
    }
    return result
  }
}
