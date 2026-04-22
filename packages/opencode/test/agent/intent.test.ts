import { describe, expect, test } from "bun:test"
import { Intent } from "../../src/agent/intent"

describe("agent.intent.classifySync", () => {
  test("detects implementation intent", () => {
    expect(Intent.classifySync("implement a new feature").type).toBe("implementation")
    expect(Intent.classifySync("add a button").type).toBe("implementation")
    expect(Intent.classifySync("create a service").type).toBe("implementation")
  })

  test("detects research intent", () => {
    expect(Intent.classifySync("explain how this works").type).toBe("research")
    expect(Intent.classifySync("how does authentication work").type).toBe("research")
  })

  test("detects fix intent", () => {
    expect(Intent.classifySync("fix the login issue").type).toBe("fix")
    expect(Intent.classifySync("there is a bug in the parser").type).toBe("fix")
    expect(Intent.classifySync("the test is failing with an error").type).toBe("fix")
  })

  test("detects investigation intent", () => {
    expect(Intent.classifySync("look into the performance issue").type).toBe("investigation")
    expect(Intent.classifySync("investigate the memory leak").type).toBe("investigation")
  })

  test("defaults to conversation", () => {
    expect(Intent.classifySync("hello there").type).toBe("conversation")
    expect(Intent.classifySync("thanks").type).toBe("conversation")
  })
})

describe("agent.intent.route", () => {
  test("maps research to explore", () => {
    expect(Intent.route(Intent.classifySync("explain how this works"))).toBe("explore")
  })

  test("maps investigation to explore", () => {
    expect(Intent.route(Intent.classifySync("look into the issue"))).toBe("explore")
  })

  test("maps implementation to build", () => {
    expect(Intent.route(Intent.classifySync("implement the feature"))).toBe("build")
  })

  test("maps fix to build", () => {
    expect(Intent.route(Intent.classifySync("fix the bug"))).toBe("build")
  })

  test("maps conversation to build", () => {
    expect(Intent.route(Intent.classifySync("hello"))).toBe("build")
  })
})

describe("agent.intent.hint", () => {
  test("returns non-empty strings for all types", () => {
    for (const type of Intent.Type.options) {
      const result: Intent.Result = { type, confidence: 0.9, routing: "", source: "regex" }
      expect(Intent.hint(result).length).toBeGreaterThan(0)
    }
  })
})
