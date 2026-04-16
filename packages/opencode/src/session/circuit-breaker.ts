export namespace CircuitBreaker {
  export type State = {
    calls: number
    edits: number
    lastProgress: number
  }

  export const DEFAULTS = {
    maxCalls: 50,
    idleMs: 300_000,
    minEdits: 1,
  }

  export function create(): State {
    return { calls: 0, edits: 0, lastProgress: Date.now() }
  }

  export function tick(state: State, event: "call" | "edit" | "test"): State {
    if (event === "call") return { calls: state.calls + 1, edits: state.edits, lastProgress: state.lastProgress }
    if (event === "edit") return { calls: state.calls, edits: state.edits + 1, lastProgress: Date.now() }
    return { calls: state.calls, edits: state.edits, lastProgress: Date.now() }
  }

  export function check(state: State, config?: Partial<typeof DEFAULTS>): "ok" | "warn" | "trip" {
    const cfg = { ...DEFAULTS, ...config }
    if (state.calls > cfg.maxCalls && state.edits < cfg.minEdits) return "trip"
    if (Date.now() - state.lastProgress > cfg.idleMs) return "warn"
    return "ok"
  }
}
