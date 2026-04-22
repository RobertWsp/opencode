import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { getParser, resetParsers } from "../parsers"

beforeAll(() => resetParsers())
afterAll(() => resetParsers())

describe("getParser", () => {
  test("returns null for unknown language", async () => {
    expect(await getParser("cobol")).toBeNull()
    expect(await getParser("")).toBeNull()
  })

  test("returns Parser for ts", async () => {
    const parser = await getParser("ts")
    expect(parser).not.toBeNull()
  })

  test("returns Parser for tsx", async () => {
    const parser = await getParser("tsx")
    expect(parser).not.toBeNull()
  })

  test("ts and tsx parsers are distinct instances", async () => {
    const ts = await getParser("ts")
    const tsx = await getParser("tsx")
    expect(ts).not.toBe(tsx)
  })

  test("same instance returned on second call (cache hit)", async () => {
    const a = await getParser("js")
    const b = await getParser("js")
    expect(a).toBe(b)
  })

  test("jsx maps to same parser as js", async () => {
    const js = await getParser("js")
    const jsx = await getParser("jsx")
    expect(js).toBe(jsx)
  })

  test("ts parser can parse valid TypeScript", async () => {
    const parser = await getParser("ts")
    expect(parser).not.toBeNull()
    const tree = parser!.parse("const x: number = 42")!
    expect(tree).not.toBeNull()
    expect(tree.rootNode.type).toBe("program")
    expect(tree.rootNode.hasError).toBe(false)
  })

  test("py parser returns non-null", async () => {
    const parser = await getParser("py")
    expect(parser).not.toBeNull()
  })

  test("go parser returns non-null", async () => {
    const parser = await getParser("go")
    expect(parser).not.toBeNull()
  })

  test("rs parser returns non-null", async () => {
    const parser = await getParser("rs")
    expect(parser).not.toBeNull()
  })
})
