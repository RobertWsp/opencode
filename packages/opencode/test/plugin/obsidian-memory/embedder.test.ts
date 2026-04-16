import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { createEmbedder } from "../../../src/plugin/obsidian-memory/embedder"

type Call = { url: string; body: unknown; headers: Record<string, string> }

let calls: Call[] = []
let ok = true
let body: unknown = null
const orig = global.fetch

function makePayload(dims: number, count: number, tokens = 100) {
  return {
    data: Array.from({ length: count }, (_, j) => ({
      embedding: Array.from({ length: dims }, (__, i) => i * 0.01 + j * 0.001 + 0.1),
    })),
    usage: { total_tokens: tokens },
  }
}

beforeEach(() => {
  calls = []
  ok = true
  body = makePayload(1024, 1)
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: input.toString(),
      body: init?.body ? JSON.parse(init.body as string) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as Response
  }
  global.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch
})

afterEach(() => {
  global.fetch = orig
})

describe("createEmbedder", () => {
  test("returns null when apiKey is undefined", () => {
    expect(createEmbedder({})).toBeNull()
  })

  test("returns null when apiKey is empty string", () => {
    expect(createEmbedder({ apiKey: "" })).toBeNull()
  })

  test("returns embedder instance when apiKey provided", () => {
    expect(createEmbedder({ apiKey: "test-key" })).not.toBeNull()
  })
})

describe("Embedder.embed", () => {
  test("sends correct payload to Voyage API", async () => {
    const embedder = createEmbedder({ apiKey: "my-key", model: "voyage-code-3" })!
    await embedder.embed(["hello world"])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://api.voyageai.com/v1/embeddings")
    expect(calls[0]!.body).toEqual({
      input: ["hello world"],
      model: "voyage-code-3",
      input_type: "document",
    })
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer my-key")
  })

  test("returns Float32Array vectors with correct dimensions", async () => {
    body = makePayload(1024, 1, 100)
    const embedder = createEmbedder({ apiKey: "key" })!
    const results = await embedder.embed(["text"])

    expect(results).toHaveLength(1)
    expect(results[0]).not.toBeNull()
    expect(results[0]!.vector).toBeInstanceOf(Float32Array)
    expect(results[0]!.vector.length).toBe(1024)
    expect(results[0]!.tokens).toBe(100)
  })

  test("handles batch of multiple texts", async () => {
    body = makePayload(1024, 3, 300)
    const embedder = createEmbedder({ apiKey: "key" })!
    const results = await embedder.embed(["a", "b", "c"])

    expect(results).toHaveLength(3)
    expect(results[0]).not.toBeNull()
    expect(results[1]).not.toBeNull()
    expect(results[2]).not.toBeNull()
    expect(results[0]!.vector.length).toBe(1024)
    expect(results[2]!.tokens).toBe(300)
  })

  test("uses input_type document by default", async () => {
    const embedder = createEmbedder({ apiKey: "key" })!
    await embedder.embed(["text"])

    expect(calls[0]!.body).toMatchObject({ input_type: "document" })
  })

  test("uses input_type query when specified", async () => {
    const embedder = createEmbedder({ apiKey: "key" })!
    await embedder.embed(["search query"], "query")

    expect(calls[0]!.body).toMatchObject({ input_type: "query" })
  })

  test("returns null array on API error", async () => {
    ok = false
    const embedder = createEmbedder({ apiKey: "key" })!
    const results = await embedder.embed(["text", "more"])

    expect(results).toHaveLength(2)
    expect(results[0]).toBeNull()
    expect(results[1]).toBeNull()
  })

  test("returns null array on network error", async () => {
    global.fetch = Object.assign(
      async () => {
        throw new Error("network error")
      },
      { preconnect: () => {} },
    ) as typeof fetch
    const embedder = createEmbedder({ apiKey: "key" })!
    const results = await embedder.embed(["text"])

    expect(results).toHaveLength(1)
    expect(results[0]).toBeNull()
  })

  test("uses default model voyage-code-3 when not specified", async () => {
    const embedder = createEmbedder({ apiKey: "key" })!
    await embedder.embed(["text"])

    expect(calls[0]!.body).toMatchObject({ model: "voyage-code-3" })
  })

  test("uses custom model when specified", async () => {
    const embedder = createEmbedder({ apiKey: "key", model: "voyage-3" })!
    await embedder.embed(["text"])

    expect(calls[0]!.body).toMatchObject({ model: "voyage-3" })
  })
})
