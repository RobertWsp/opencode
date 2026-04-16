import z from "zod"

export namespace ContextTiers {
  export const TierConfig = z.object({
    tier1Max: z.number(),
    tier2Max: z.number(),
    tier3Max: z.number(),
  })
  export type TierConfig = z.infer<typeof TierConfig>

  export const DEFAULTS: TierConfig = { tier1Max: 8000, tier2Max: 4000, tier3Max: 6000 }

  export function allocate(content: string[], tier: 1 | 2 | 3, config?: TierConfig): string[] {
    const cfg = config ?? DEFAULTS
    const max = tier === 1 ? cfg.tier1Max : tier === 2 ? cfg.tier2Max : cfg.tier3Max
    let tokens = 0
    const cut = content.findIndex((item) => {
      tokens += Math.ceil(item.length / 4)
      return tokens > max
    })
    if (cut === -1) return content
    return content.slice(0, cut)
  }

  export function total(config?: TierConfig): number {
    const cfg = config ?? DEFAULTS
    return cfg.tier1Max + cfg.tier2Max + cfg.tier3Max
  }

  export function remaining(used: { tier1: number; tier2: number; tier3: number }, config?: TierConfig): number {
    const cfg = config ?? DEFAULTS
    return cfg.tier1Max - used.tier1 + (cfg.tier2Max - used.tier2) + (cfg.tier3Max - used.tier3)
  }
}
