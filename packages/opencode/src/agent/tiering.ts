import z from "zod"

export namespace Tiering {
  export const Tier = z.enum(["quality", "balanced", "budget", "adaptive", "inherit"])
  export type Tier = z.infer<typeof Tier>

  export type TierMap = Record<string, string>

  export const DEFAULTS: Record<Tier, TierMap> = {
    quality: {
      anthropic: "claude-opus-4-7",
      openai: "gpt-5",
      google: "gemini-2.5-pro",
    },
    balanced: {
      anthropic: "claude-sonnet-4-6",
      openai: "gpt-4.1",
      google: "gemini-2.5-flash",
    },
    budget: {
      anthropic: "claude-haiku-4-5-20251001",
      openai: "gpt-4.1-mini",
      google: "gemini-2.0-flash-lite",
    },
    adaptive: {},
    inherit: {},
  }

  export function resolve(
    tier: Tier,
    provider: string,
    overrides?: Record<Tier, TierMap>,
  ): { providerID: string; modelID: string } {
    const custom = overrides?.[tier]?.[provider]
    if (custom) return { providerID: provider, modelID: custom }
    const exact = DEFAULTS[tier]?.[provider]
    if (exact) return { providerID: provider, modelID: exact }
    const fallback =
      overrides?.["balanced"]?.[provider] ?? DEFAULTS["balanced"]?.[provider] ?? ""
    return { providerID: provider, modelID: fallback }
  }

  export function adaptive(history: { tokens: number; tools: number; files: number }): Tier {
    if (history.tokens > 50000 || history.files > 15) return "quality"
    if (history.tools > 10 || history.files > 5) return "balanced"
    return "budget"
  }

  export function fromParent(tier: Tier, parent: Tier | undefined): Tier {
    if (tier === "inherit") return parent ?? "balanced"
    return tier
  }
}
