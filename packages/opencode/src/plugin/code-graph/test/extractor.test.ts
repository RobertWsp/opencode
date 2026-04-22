import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { extract } from "../extractor"
import { getParser, resetParsers } from "../parsers"
import { NodeKind, EdgeKind } from "../types"

beforeAll(() => resetParsers())
afterAll(() => resetParsers())

async function parse(code: string, lang: string) {
  const parser = await getParser(lang)
  if (!parser) throw new Error(`no parser for ${lang}`)
  return parser.parse(code)!
}

const FILE = "/src/example.ts"
const HASH = "abc123"

describe("extract – TypeScript", () => {
  test("extracts top-level function declaration", async () => {
    const tree = await parse("function greet(name: string) { return name }", "ts")
    const { nodes } = extract(tree, FILE, HASH, "ts")
    const fn = nodes.find((n) => n.name === "greet")
    expect(fn).toBeDefined()
    expect(fn?.kind).toBe(NodeKind.Function)
    expect(fn?.qualifiedName).toBe(`${FILE}::greet`)
    expect(fn?.lineStart).toBe(1)
  })

  test("extracts exported function declaration", async () => {
    const tree = await parse("export function send(msg: string) {}", "ts")
    const { nodes } = extract(tree, FILE, HASH, "ts")
    expect(nodes.find((n) => n.name === "send")).toBeDefined()
  })

  test("extracts class with methods", async () => {
    const code = `class Repo {
  find(id: string) { return id }
  save(item: object) {}
}`
    const tree = await parse(code, "ts")
    const { nodes } = extract(tree, FILE, HASH, "ts")
    expect(nodes.find((n) => n.name === "Repo")?.kind).toBe(NodeKind.Class)
    expect(nodes.find((n) => n.name === "find")?.parentName).toBe("Repo")
    expect(nodes.find((n) => n.name === "save")?.parentName).toBe("Repo")
  })

  test("extracts interface declaration as Type", async () => {
    const tree = await parse("interface User { id: string; name: string }", "ts")
    const { nodes } = extract(tree, FILE, HASH, "ts")
    expect(nodes.find((n) => n.name === "User")?.kind).toBe(NodeKind.Type)
  })

  test("extracts type alias as Type", async () => {
    const tree = await parse("type Result<T> = { data: T; error: null }", "ts")
    const { nodes } = extract(tree, FILE, HASH, "ts")
    expect(nodes.find((n) => n.name === "Result")?.kind).toBe(NodeKind.Type)
  })

  test("extracts arrow function from lexical declaration", async () => {
    const tree = await parse("const handler = async (req: Request) => req.json()", "ts")
    const { nodes } = extract(tree, FILE, HASH, "ts")
    expect(nodes.find((n) => n.name === "handler")?.kind).toBe(NodeKind.Function)
  })

  test("extracts import as IMPORTS_FROM edge", async () => {
    const tree = await parse(`import { foo } from "./utils"`, "ts")
    const { edges } = extract(tree, FILE, HASH, "ts")
    const edge = edges.find((e) => e.kind === EdgeKind.IMPORTS_FROM)
    expect(edge).toBeDefined()
    expect(edge?.tgtQualifiedName).toBe("./utils")
    expect(edge?.srcQualifiedName).toBe(FILE)
  })

  test("returns empty for unsupported lang", async () => {
    const tree = await parse("function x() {}", "ts")
    const result = extract(tree, FILE, HASH, "cobol")
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
  })

  test("stable qualified name across calls", async () => {
    const code = "function stable() {}"
    const tree = await parse(code, "ts")
    const r1 = extract(tree, FILE, HASH, "ts")
    const r2 = extract(tree, FILE, HASH, "ts")
    expect(r1.nodes[0].qualifiedName).toBe(r2.nodes[0].qualifiedName)
    expect(r1.nodes[0].id).toBe(r2.nodes[0].id)
  })
})

describe("extract – JavaScript", () => {
  test("extracts function and class from JS", async () => {
    const code = `
function compute(x) { return x * 2 }
class Store { get(key) { return key } }
`
    const tree = await parse(code, "js")
    const { nodes } = extract(tree, "/src/a.js", HASH, "js")
    expect(nodes.find((n) => n.name === "compute")?.kind).toBe(NodeKind.Function)
    expect(nodes.find((n) => n.name === "Store")?.kind).toBe(NodeKind.Class)
  })
})

describe("extract – Python", () => {
  test("extracts function and class from Python", async () => {
    const code = `
def greet(name):
    return name

class Service:
    def run(self):
        pass
`
    const tree = await parse(code, "py")
    const { nodes } = extract(tree, "/src/a.py", HASH, "py")
    expect(nodes.find((n) => n.name === "greet")?.kind).toBe(NodeKind.Function)
    expect(nodes.find((n) => n.name === "Service")?.kind).toBe(NodeKind.Class)
  })
})
