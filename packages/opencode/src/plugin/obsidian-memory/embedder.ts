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
      const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
      const payload = JSON.stringify({ input: texts, model, input_type: type })
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(ENDPOINT, { method: "POST", headers, body: payload })
          if (res.status === 429) {
            await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000 + Math.random() * 500))
            continue
          }
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
          if (attempt === 2) {
            log.warn("voyage embed error after retries", { error: String(err) })
            return texts.map(() => null)
          }
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500))
        }
      }
      return texts.map(() => null)
    },
  }
}
