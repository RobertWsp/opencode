import { describe, it, expect, beforeEach, mock } from "bun:test"

type HaikuArgs = { systemPrompt: string; userMessage: string; model: string; maxTokens?: number; timeoutMs?: number }
type HaikuResult = { ok: boolean; text?: string; error?: string; durationMs: number }

const haikuQueue: HaikuResult[] = []
const haikuCalls: HaikuArgs[] = []

mock.module("../plugin/obsidian-memory/haiku-client", () => ({
  callHaiku: async (args: HaikuArgs): Promise<HaikuResult> => {
    haikuCalls.push(args)
    return haikuQueue.shift() ?? { ok: false, error: "no mock queued", durationMs: 0 }
  },
}))

const { Intent } = await import("./intent")

beforeEach(() => {
  Intent._resetCache()
  haikuQueue.length = 0
  haikuCalls.length = 0
})

describe("Intent.classifySync (regex multi-language)", () => {
  it("classifies English", () => {
    expect(Intent.classifySync("fix the login bug").type).toBe("fix")
    expect(Intent.classifySync("implement oauth flow").type).toBe("implementation")
    expect(Intent.classifySync("explain how closures work").type).toBe("research")
    expect(Intent.classifySync("look into the flaky test").type).toBe("investigation")
    expect(Intent.classifySync("what do you think of redux?").type).toBe("evaluation")
    expect(Intent.classifySync("hi there").type).toBe("conversation")
  })

  it("classifies Portuguese", () => {
    expect(Intent.classifySync("corrigir o bug do login").type).toBe("fix")
    expect(Intent.classifySync("implementar o fluxo oauth").type).toBe("implementation")
    expect(Intent.classifySync("como funciona closures").type).toBe("research")
    expect(Intent.classifySync("investigar o teste flaky").type).toBe("investigation")
    expect(Intent.classifySync("o que você acha de redux?").type).toBe("evaluation")
    expect(Intent.classifySync("olá").type).toBe("conversation")
  })

  it("fix wins over implementation when both verbs present", () => {
    expect(Intent.classifySync("add a fix for the login bug").type).toBe("fix")
  })

  it("documentation wins over implementation when writing docs", () => {
    expect(Intent.classifySync("write the README for this project").type).toBe("documentation")
    expect(Intent.classifySync("escrever a documentação do módulo").type).toBe("documentation")
    expect(Intent.classifySync("update the CHANGELOG").type).toBe("documentation")
    expect(Intent.classifySync("write JSDoc for foo.ts").type).toBe("documentation")
    expect(Intent.classifySync("document the payments module").type).toBe("documentation")
    expect(Intent.classifySync("atualizar o changelog").type).toBe("documentation")
  })

  it("documentation does NOT swallow code tasks", () => {
    expect(Intent.classifySync("write unit tests for foo").type).toBe("implementation")
    expect(Intent.classifySync("create a new endpoint").type).toBe("implementation")
    expect(Intent.classifySync("criar um handler novo").type).toBe("implementation")
  })

  it("source is always regex", () => {
    expect(Intent.classifySync("fix bug").source).toBe("regex")
  })

  it("recognizes real pt-br user phrasings (análise/estudo/revisão/pesquise)", () => {
    expect(Intent.classifySync("faça uma análise detalhada do sistema").type).toBe("investigation")
    expect(Intent.classifySync("faça um estudo detalhado corretamente").type).toBe("investigation")
    expect(Intent.classifySync("faça uma revisão detalhada").type).toBe("investigation")
    expect(Intent.classifySync("estude em detalhes o sistema").type).toBe("investigation")
    expect(Intent.classifySync("pesquise mais sobre o caveman").type).toBe("investigation")
    expect(Intent.classifySync("identificar os padrões e validar o sistema").type).toBe("investigation")
    expect(Intent.classifySync("Análise cada sessão do README").type).toBe("investigation")
  })

  it("recognizes pt-br 'correção' as fix", () => {
    expect(Intent.classifySync("faça a correção do sistema").type).toBe("fix")
    expect(Intent.classifySync("Eu preciso que faça a correção corretamente").type).toBe("fix")
    expect(Intent.classifySync("aplique as correções necessárias").type).toBe("fix")
  })

  it("recognizes 'refactor' as implementation", () => {
    expect(Intent.classifySync("refactor nossa arquitetura de autenticacao").type).toBe("implementation")
    expect(Intent.classifySync("refatorar o módulo de payments").type).toBe("implementation")
  })
})

describe("Intent.classify with Haiku", () => {
  it("parses a well-formed Haiku JSON response", async () => {
    haikuQueue.push({ ok: true, text: '{"type":"research","confidence":0.92}', durationMs: 100 })
    const r = await Intent.classify("algo nada obvio sobre X", { classifier: "haiku" })
    expect(r.type).toBe("research")
    expect(r.confidence).toBeCloseTo(0.92)
    expect(r.source).toBe("haiku")
  })

  it("strips ```json code fences", async () => {
    haikuQueue.push({ ok: true, text: '```json\n{"type":"fix","confidence":0.8}\n```', durationMs: 90 })
    const r = await Intent.classify("message", { classifier: "haiku" })
    expect(r.type).toBe("fix")
    expect(r.source).toBe("haiku")
  })

  it("falls back to regex on invalid JSON", async () => {
    haikuQueue.push({ ok: true, text: "not json at all", durationMs: 80 })
    const r = await Intent.classify("fix this bug", { classifier: "haiku" })
    expect(r.type).toBe("fix")
    expect(r.source).toBe("haiku-fallback")
  })

  it("falls back to regex on invalid type value", async () => {
    haikuQueue.push({ ok: true, text: '{"type":"weird","confidence":1}', durationMs: 50 })
    const r = await Intent.classify("fix this bug", { classifier: "haiku" })
    expect(r.source).toBe("haiku-fallback")
    expect(r.type).toBe("fix")
  })

  it("falls back to regex on transport error", async () => {
    haikuQueue.push({ ok: false, error: "timeout", durationMs: 3001 })
    const r = await Intent.classify("explique X", { classifier: "haiku" })
    expect(r.source).toBe("haiku-fallback")
    expect(r.type).toBe("research")
  })

  it("passes timeoutMs and model through to callHaiku", async () => {
    haikuQueue.push({ ok: true, text: '{"type":"conversation","confidence":0.5}', durationMs: 10 })
    await Intent.classify("hey", { classifier: "haiku", timeoutMs: 1500, model: "custom-model" })
    expect(haikuCalls[0].timeoutMs).toBe(1500)
    expect(haikuCalls[0].model).toBe("custom-model")
  })

  it("clamps confidence into [0,1]", async () => {
    haikuQueue.push({ ok: true, text: '{"type":"fix","confidence":5}', durationMs: 10 })
    const r = await Intent.classify("fix x", { classifier: "haiku" })
    expect(r.confidence).toBe(1)
  })
})

describe("Intent.classify cache", () => {
  it("caches identical regex queries", async () => {
    const r1 = await Intent.classify("explain closures", { classifier: "regex" })
    const r2 = await Intent.classify("explain closures", { classifier: "regex" })
    expect(r1).toBe(r2)
  })

  it("keys regex and haiku separately", async () => {
    haikuQueue.push({ ok: true, text: '{"type":"research","confidence":0.9}', durationMs: 10 })
    const regex = await Intent.classify("explain X", { classifier: "regex" })
    const haiku = await Intent.classify("explain X", { classifier: "haiku" })
    expect(regex.source).toBe("regex")
    expect(haiku.source).toBe("haiku")
  })
})

describe("Intent.hint / route", () => {
  it("hint reflects type", () => {
    const r = Intent.classifySync("fix bug")
    expect(Intent.hint(r)).toContain("root cause")
  })

  it("route maps to agent name", () => {
    expect(Intent.route(Intent.classifySync("explain X"))).toBe("explore")
    expect(Intent.route(Intent.classifySync("implement Y"))).toBe("build")
    expect(Intent.route(Intent.classifySync("compare A and B"))).toBe("general")
    expect(Intent.route(Intent.classifySync("hi"))).toBe("build")
  })
})
