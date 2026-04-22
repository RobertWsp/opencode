import { describe, it, expect, beforeEach, mock } from "bun:test"

type Cfg = { experimental?: { caveman?: Record<string, unknown> } }
const key = "__caveman_test_cfg__"
const root = globalThis as typeof globalThis & { [k: string]: Cfg | undefined }
const state: Cfg = root[key] ?? (root[key] = {})

mock.module("../config/config", () => ({
  Config: {
    get: async () => state,
  },
}))

const { Caveman } = await import("./caveman")
type Caveman = typeof Caveman
type CavemanSettings = Parameters<typeof Caveman.shouldActivate>[2]

const base: CavemanSettings = {
  enabled: true,
  level: "full",
  intents: ["research", "investigation", "evaluation", "implementation", "fix"],
  minMessageLength: 0,
  classifier: "regex",
  classifierTimeoutMs: 3000,
  agents: {},
}

describe("Caveman.shouldActivate", () => {
  it("skips when disabled", () => {
    expect(Caveman.shouldActivate("research", "explain X", { ...base, enabled: false })).toBe(false)
  })

  it("activates for eligible intents by default", () => {
    expect(Caveman.shouldActivate("research", "explain X", base)).toBe(true)
    expect(Caveman.shouldActivate("investigation", "look into Y", base)).toBe(true)
    expect(Caveman.shouldActivate("evaluation", "what do you think", base)).toBe(true)
    expect(Caveman.shouldActivate("implementation", "add feature", base)).toBe(true)
    expect(Caveman.shouldActivate("fix", "fix the bug", base)).toBe(true)
  })

  it("skips documentation and conversation by default", () => {
    expect(Caveman.shouldActivate("documentation", "write the README", base)).toBe(false)
    expect(Caveman.shouldActivate("conversation", "hi", base)).toBe(false)
  })

  it("honors custom intent list", () => {
    const settings: CavemanSettings = { ...base, intents: ["fix"] }
    expect(Caveman.shouldActivate("fix", "fix the bug", settings)).toBe(true)
    expect(Caveman.shouldActivate("research", "explain X", settings)).toBe(false)
  })

  it("skips when message shorter than minMessageLength", () => {
    expect(Caveman.shouldActivate("research", "why?", { ...base, minMessageLength: 20 })).toBe(false)
    expect(Caveman.shouldActivate("research", "explain in a short paragraph", { ...base, minMessageLength: 20 })).toBe(
      true,
    )
  })
})

describe("Caveman.disabledByMessage", () => {
  it("detects English disable phrases", () => {
    expect(Caveman.disabledByMessage("please explain in detail")).toBe(true)
    expect(Caveman.disabledByMessage("go in depth")).toBe(true)
    expect(Caveman.disabledByMessage("give me a verbose answer")).toBe(true)
    expect(Caveman.disabledByMessage("stop caveman")).toBe(true)
    expect(Caveman.disabledByMessage("no caveman please")).toBe(true)
    expect(Caveman.disabledByMessage("walk me through step-by-step")).toBe(true)
  })

  it("detects Portuguese disable phrases", () => {
    expect(Caveman.disabledByMessage("me explique detalhadamente")).toBe(true)
    expect(Caveman.disabledByMessage("passo a passo")).toBe(true)
    expect(Caveman.disabledByMessage("explique tudo")).toBe(true)
  })

  it("returns false for normal queries", () => {
    expect(Caveman.disabledByMessage("explain how closures work")).toBe(false)
    expect(Caveman.disabledByMessage("what is async")).toBe(false)
  })

  it("overrides shouldActivate", () => {
    expect(Caveman.shouldActivate("research", "explain X in full detail please", base)).toBe(false)
  })

  it("avoids false positives on incidental keywords", () => {
    expect(Caveman.disabledByMessage("set verbose=true in config")).toBe(false)
    expect(Caveman.disabledByMessage("log the retail details field")).toBe(false)
    expect(Caveman.disabledByMessage("the detail page shows X")).toBe(false)
    expect(Caveman.disabledByMessage("add stepByStep handler")).toBe(false)
  })

  it("pt-br 'detalhada' as work-request (NOT verbose) does NOT disable", () => {
    expect(Caveman.disabledByMessage("faça uma análise detalhada do sistema")).toBe(false)
    expect(Caveman.disabledByMessage("faça um estudo detalhado corretamente porfavor")).toBe(false)
    expect(Caveman.disabledByMessage("faça uma revisão detalhada")).toBe(false)
    expect(Caveman.disabledByMessage("estude em detalhes o sistema")).toBe(false)
    expect(Caveman.disabledByMessage("análise detalhada corretamente")).toBe(false)
  })

  it("pt-br instruction + detail (verbose request) DOES disable", () => {
    expect(Caveman.disabledByMessage("explique detalhadamente")).toBe(true)
    expect(Caveman.disabledByMessage("me explique em detalhes")).toBe(true)
    expect(Caveman.disabledByMessage("me conte em detalhes o que houve")).toBe(true)
    expect(Caveman.disabledByMessage("explique detalhadamente como funciona")).toBe(true)
  })
})

describe("Caveman.reenabledByMessage", () => {
  it("detects re-enable phrases (en + pt)", () => {
    expect(Caveman.reenabledByMessage("caveman on")).toBe(true)
    expect(Caveman.reenabledByMessage("turn caveman back on")).toBe(true)
    expect(Caveman.reenabledByMessage("caveman resume")).toBe(true)
    expect(Caveman.reenabledByMessage("ligar caveman")).toBe(true)
    expect(Caveman.reenabledByMessage("ativar caveman")).toBe(true)
    expect(Caveman.reenabledByMessage("voltar caveman")).toBe(true)
  })

  it("returns false for noise", () => {
    expect(Caveman.reenabledByMessage("explain something")).toBe(false)
    expect(Caveman.reenabledByMessage("caveman is great")).toBe(false)
  })
})

describe("Caveman.hint", () => {
  it("contains level tag", () => {
    expect(Caveman.hint("lite")).toContain('level="lite"')
    expect(Caveman.hint("full")).toContain('level="full"')
    expect(Caveman.hint("ultra")).toContain('level="ultra"')
  })

  it("preserves auto-clarity and boundary rules", () => {
    const h = Caveman.hint("full")
    expect(h).toContain("security warnings")
    expect(h).toContain("normal prose")
    expect(h).toContain("stop caveman")
  })

  it("scopes to speech not thinking", () => {
    const h = Caveman.hint("full")
    expect(h).toContain("how you talk")
    expect(h).toContain("not *how you think*")
    expect(h).toContain("tool call arguments")
    expect(h).toContain("Reasoning quality")
  })
})

describe("Caveman.settings (config integration)", () => {
  beforeEach(() => {
    for (const k of Object.keys(state)) delete (state as Record<string, unknown>)[k]
    delete process.env.OPENCODE_EXPERIMENTAL_CAVEMAN
    delete process.env.OPENCODE_EXPERIMENTAL_CAVEMAN_LEVEL
    delete process.env.OPENCODE_EXPERIMENTAL_CAVEMAN_CLASSIFIER
  })

  it("defaults to enabled=false (experimental opt-in) with level=full", async () => {
    const s = await Caveman.settings()
    expect(s.enabled).toBe(false)
    expect(s.level).toBe("full")
    expect(s.intents).toEqual(["research", "investigation", "evaluation", "implementation", "fix"])
    expect(s.classifier).toBe("haiku")
    expect(s.classifierTimeoutMs).toBe(3000)
  })

  it("env OPENCODE_EXPERIMENTAL_CAVEMAN=true enables", async () => {
    process.env.OPENCODE_EXPERIMENTAL_CAVEMAN = "true"
    const s = await Caveman.settings()
    expect(s.enabled).toBe(true)
  })

  it("env OPENCODE_EXPERIMENTAL_CAVEMAN=false disables", async () => {
    process.env.OPENCODE_EXPERIMENTAL_CAVEMAN = "false"
    const s = await Caveman.settings()
    expect(s.enabled).toBe(false)
  })

  it("config overrides env and defaults", async () => {
    state.experimental = {
      caveman: { enabled: true, level: "ultra", intents: ["fix"], classifier: "regex", classifierTimeoutMs: 500 },
    }
    process.env.OPENCODE_EXPERIMENTAL_CAVEMAN = "false"
    const s = await Caveman.settings()
    expect(s.enabled).toBe(true)
    expect(s.level).toBe("ultra")
    expect(s.intents).toEqual(["fix"])
    expect(s.classifier).toBe("regex")
    expect(s.classifierTimeoutMs).toBe(500)
  })

  it("env level overrides config level", async () => {
    state.experimental = { caveman: { level: "lite" } }
    process.env.OPENCODE_EXPERIMENTAL_CAVEMAN_LEVEL = "ultra"
    const s = await Caveman.settings()
    expect(s.level).toBe("ultra")
  })

  it("env classifier overrides config classifier", async () => {
    state.experimental = { caveman: { classifier: "haiku" } }
    process.env.OPENCODE_EXPERIMENTAL_CAVEMAN_CLASSIFIER = "regex"
    const s = await Caveman.settings()
    expect(s.classifier).toBe("regex")
  })
})

describe("Caveman.forAgent", () => {
  it("returns settings unchanged when agent name absent", () => {
    const s = Caveman.forAgent(base)
    expect(s).toBe(base)
  })

  it("prose-artifact agents are disabled by builtin default", () => {
    const s = Caveman.forAgent(base, "prometheus")
    expect(s.enabled).toBe(false)
    expect(Caveman.forAgent(base, "momus").enabled).toBe(false)
    expect(Caveman.forAgent(base, "metis").enabled).toBe(false)
  })

  it("non-prose agents inherit base settings", () => {
    expect(Caveman.forAgent(base, "explore").enabled).toBe(true)
    expect(Caveman.forAgent(base, "hephaestus").enabled).toBe(true)
    expect(Caveman.forAgent(base, "oracle").enabled).toBe(true)
  })

  it("user override beats builtin defaults", () => {
    const s = Caveman.forAgent({ ...base, agents: { prometheus: { enabled: true } } }, "prometheus")
    expect(s.enabled).toBe(true)
  })

  it("user override applies level per agent", () => {
    const s = Caveman.forAgent({ ...base, agents: { explore: { level: "ultra" } } }, "explore")
    expect(s.level).toBe("ultra")
    expect(s.enabled).toBe(true)
  })

  it("can disable specific non-prose agent via config", () => {
    const s = Caveman.forAgent({ ...base, agents: { build: { enabled: false } } }, "build")
    expect(s.enabled).toBe(false)
  })
})
