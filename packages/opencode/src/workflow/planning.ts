import z from "zod"
import fs from "fs"
import path from "path"

export namespace Planning {
  export const DIR = ".opencode/planning"

  export const Decision = z.object({
    id: z.string(),
    title: z.string(),
    rationale: z.string(),
    locked: z.boolean(),
    kind: z.enum(["locked", "deferred", "discretion"]).default("locked"),
  })
  export type Decision = z.infer<typeof Decision>

  export function fidelity(decisions: Decision[]): string {
    const locked = decisions.filter((d) => d.kind === "locked")
    const deferred = decisions.filter((d) => d.kind === "deferred")
    if (locked.length === 0 && deferred.length === 0) return ""
    const parts: string[] = ["<context_fidelity>", "Before creating ANY task, verify:"]
    if (locked.length > 0) {
      parts.push("1. Locked Decisions — MUST be implemented exactly:")
      locked.forEach((d) => parts.push(`   ${d.id}: ${d.title}`))
    }
    if (deferred.length > 0) {
      parts.push("2. Deferred Ideas — MUST NOT appear in plans:")
      deferred.forEach((d) => parts.push(`   ${d.id}: ${d.title}`))
    }
    parts.push("3. Discretion — Use your judgment for unlisted items")
    parts.push("</context_fidelity>")
    return parts.join("\n")
  }

  export async function init(root: string): Promise<void> {
    await fs.promises.mkdir(path.join(root, DIR), { recursive: true })
    const ctx = Bun.file(path.join(root, DIR, "CONTEXT.md"))
    const plan = Bun.file(path.join(root, DIR, "PLAN.md"))
    const status = Bun.file(path.join(root, DIR, "STATUS.md"))
    if (!(await ctx.exists())) await Bun.write(path.join(root, DIR, "CONTEXT.md"), "# Context\n")
    if (!(await plan.exists())) await Bun.write(path.join(root, DIR, "PLAN.md"), "# Plan\n")
    if (!(await status.exists())) await Bun.write(path.join(root, DIR, "STATUS.md"), "# Status\n")
  }

  export async function decisions(root: string): Promise<Decision[]> {
    const file = Bun.file(path.join(root, DIR, "CONTEXT.md"))
    if (!(await file.exists())) return []
    const content = await file.text()
    const matches = content.matchAll(/<!-- DECISION (.*?) -->/g)
    return Array.from(matches).map((m) => Decision.parse(JSON.parse(m[1])))
  }

  export async function addDecision(
    root: string,
    decision: Omit<z.input<typeof Decision>, "id">,
  ): Promise<Decision> {
    const existing = await decisions(root)
    const id = `D-${String(existing.length + 1).padStart(2, "0")}`
    const next: Decision = Decision.parse({ id, ...decision })
    const file = Bun.file(path.join(root, DIR, "CONTEXT.md"))
    const prev = (await file.exists()) ? await file.text() : "# Context\n"
    await Bun.write(path.join(root, DIR, "CONTEXT.md"), prev + `\n<!-- DECISION ${JSON.stringify(next)} -->\n`)
    return next
  }

  export async function plan(root: string): Promise<string> {
    return Bun.file(path.join(root, DIR, "PLAN.md")).text()
  }

  export async function writePlan(root: string, content: string): Promise<void> {
    await Bun.write(path.join(root, DIR, "PLAN.md"), content)
  }

  export async function status(root: string): Promise<string> {
    return Bun.file(path.join(root, DIR, "STATUS.md")).text()
  }

  export async function writeStatus(root: string, content: string): Promise<void> {
    await Bun.write(path.join(root, DIR, "STATUS.md"), content)
  }
}
