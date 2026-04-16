export namespace Budget {
  export type Usage = {
    tokens: { input: number; output: number }
    cost: number
    calls: number
  }

  export type Limit = {
    session: number
    agent: number
  }

  const store = new Map<string, Map<string, Usage>>()

  function agents(session: string): Map<string, Usage> {
    if (!store.has(session)) store.set(session, new Map())
    return store.get(session)!
  }

  export function track(session: string, agent: string, tokens: { input: number; output: number }, cost: number): void {
    const map = agents(session)
    const prev = map.get(agent) ?? { tokens: { input: 0, output: 0 }, cost: 0, calls: 0 }
    map.set(agent, {
      tokens: { input: prev.tokens.input + tokens.input, output: prev.tokens.output + tokens.output },
      cost: prev.cost + cost,
      calls: prev.calls + 1,
    })
  }

  export function usage(session: string, agent?: string): Usage {
    const map = agents(session)
    if (agent !== undefined) return map.get(agent) ?? { tokens: { input: 0, output: 0 }, cost: 0, calls: 0 }
    let input = 0
    let output = 0
    let cost = 0
    let calls = 0
    for (const u of map.values()) {
      input += u.tokens.input
      output += u.tokens.output
      cost += u.cost
      calls += u.calls
    }
    return { tokens: { input, output }, cost, calls }
  }

  export function check(session: string, limits: Limit): "ok" | "warn" | "exceeded" {
    const total = usage(session).cost
    if (total > limits.session) return "exceeded"
    if (total > limits.session * 0.8) return "warn"
    return "ok"
  }

  export function reset(session: string): void {
    store.delete(session)
  }

  export function format(session: string): string {
    const map = agents(session)
    const total = usage(session)
    const lines: string[] = [`session cost: $${(total.cost / 100).toFixed(4)} (${total.calls} calls)`]
    for (const [agent, u] of map.entries()) {
      lines.push(`  ${agent}: $${(u.cost / 100).toFixed(4)} | in=${u.tokens.input} out=${u.tokens.output}`)
    }
    return lines.join("\n")
  }
}
