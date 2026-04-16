import z from "zod"

export namespace Intent {
  export const Type = z.enum(["research", "implementation", "investigation", "evaluation", "fix", "conversation"])
  export type Type = z.infer<typeof Type>

  export type Result = {
    type: Type
    confidence: number
    routing: string
  }

  function detect(msg: string): Type {
    if (/\b(fix|bug|error|broken|failing)\b/.test(msg)) return "fix"
    if (/\b(implement|add|create|build|write)\b/.test(msg)) return "implementation"
    if (/explain|how does|what is|why/.test(msg)) return "research"
    if (/look into|check|investigate|find/.test(msg)) return "investigation"
    if (/what do you think|evaluate|compare/.test(msg)) return "evaluation"
    return "conversation"
  }

  function agentFor(type: Type): string {
    if (type === "research") return "explore"
    if (type === "investigation") return "explore"
    if (type === "implementation") return "build"
    if (type === "fix") return "build"
    if (type === "evaluation") return "general"
    return "build"
  }

  export function classify(message: string): Result {
    const msg = message.toLowerCase()
    const type = detect(msg)
    return { type, confidence: 0.9, routing: agentFor(type) }
  }

  export function route(result: Result): string {
    return agentFor(result.type)
  }

  export function hint(result: Result): string {
    if (result.type === "research") return "Focus on explaining concepts clearly with examples."
    if (result.type === "implementation") return "Write clean, production-ready code following project conventions."
    if (result.type === "investigation") return "Explore the codebase thoroughly before drawing conclusions."
    if (result.type === "evaluation") return "Provide balanced analysis with concrete trade-offs."
    if (result.type === "fix") return "Identify the root cause before proposing a fix."
    return "Respond conversationally and helpfully."
  }
}
