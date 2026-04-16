import { describe, expect, test } from "bun:test"
import { Intent } from "../../src/agent/intent"

describe("agent.intent.classify", () => {
  test("detects implementation intent", () => {
    expect(Intent.classify("implement a new feature").type).toBe("implementation")
    expect(Intent.classify("add a button").type).toBe("implementation")
    expect(Intent.classify("create a service").type).toBe("implementation")
  })

  test("detects research intent", () => {
    expect(Intent.classify("explain how this works").type).toBe("research")
    expect(Intent.classify("how does authentication work").type).toBe("research")
  })

  test("detects fix intent", () => {
    expect(Intent.classify("fix the login issue").type).toBe("fix")
    expect(Intent.classify("there is a bug in the parser").type).toBe("fix")
    expect(Intent.classify("the test is failing with an error").type).toBe("fix")
  })

  test("detects investigation intent", () => {
    expect(Intent.classify("look into the performance issue").type).toBe("investigation")
    expect(Intent.classify("investigate the memory leak").type).toBe("investigation")
  })

  test("defaults to conversation", () => {
    expect(Intent.classify("hello there").type).toBe("conversation")
    expect(Intent.classify("thanks").type).toBe("conversation")
  })
})

describe("agent.intent.route", () => {
  test("maps research to explore", () => {
    expect(Intent.route(Intent.classify("explain how this works"))).toBe("explore")
  })

  test("maps investigation to explore", () => {
    expect(Intent.route(Intent.classify("look into the issue"))).toBe("explore")
  })

  test("maps implementation to build", () => {
    expect(Intent.route(Intent.classify("implement the feature"))).toBe("build")
  })

  test("maps fix to build", () => {
    expect(Intent.route(Intent.classify("fix the bug"))).toBe("build")
  })

  test("maps conversation to build", () => {
    expect(Intent.route(Intent.classify("hello"))).toBe("build")
  })
})

describe("agent.intent.hint", () => {
  test("returns non-empty strings for all types", () => {
    for (const type of Intent.Type.options) {
      const result: Intent.Result = { type, confidence: 0.9, routing: "" }
      expect(Intent.hint(result).length).toBeGreaterThan(0)
    }
  })
})
