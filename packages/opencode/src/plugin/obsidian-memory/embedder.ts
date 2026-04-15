import { Log } from "../../util/log"

const log = Log.create({ service: "plugin.obsidian-memory.embedder" })

const ENDPOINT = "https://api.voyageai.com/v1/embeddings"

export interface EmbedResult {
  vector: Float32Array
  tokens: number
}

export interface Embedder {
  embed(texts: string[], type?: "document" | "query"): Promise<(EmbedResult | null)[]>
}

export function createEmbedder(opts: {
  apiKey?: string
  model?: string
  dimensions?: number
}): Embedder | null {
  if (!opts.apiKey) return null
  const key = opts.apiKey
  const model = opts.model ?? "voyage-code-3"

  return {
    async embed(texts, type = "document") {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ input: texts, model, input_type: type }),
        })
        if (!res.ok) {
          log.warn("voyage embed failed", { status: res.status })
          return texts.map(() => null)
        }
        const body = (await res.json()) as {
          data: { embedding: number[] }[]
          usage: { total_tokens: number }
        }
        const tokens = body.usage.total_tokens
        return body.data.map((item) => ({
          vector: new Float32Array(item.embedding),
          tokens,
        }))
      } catch (err) {
        log.warn("voyage embed error", { error: String(err) })
        return texts.map(() => null)
      }
    },
  }
}
