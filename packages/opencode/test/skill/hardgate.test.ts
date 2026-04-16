import { describe, test, expect } from "bun:test"
import { HardGate } from "../../src/skill/hardgate"

describe("HardGate.parse", () => {
  test("extracts gate from content with HARD-GATE tag", () => {
    const content = "<HARD-GATE>\nblocked: bash\nDo not run commands\n</HARD-GATE>"
    const gates = HardGate.parse(content)
    expect(gates.length).toBe(1)
    expect(gates[0].blocked).toEqual(["bash"])
    expect(gates[0].condition).toBe("Do not run commands")
  })

  test("returns empty array for content without gates", () => {
    expect(HardGate.parse("no gates here")).toEqual([])
    expect(HardGate.parse("")).toEqual([])
  })

  test("handles multiple gates", () => {
    const content = [
      "<HARD-GATE>",
      "blocked: bash, python",
      "First condition",
      "</HARD-GATE>",
      "<HARD-GATE>",
      "blocked: write",
      "Second condition",
      "</HARD-GATE>",
    ].join("\n")
    const gates = HardGate.parse(content)
    expect(gates.length).toBe(2)
    expect(gates[0].blocked).toEqual(["bash", "python"])
    expect(gates[0].condition).toBe("First condition")
    expect(gates[1].blocked).toEqual(["write"])
    expect(gates[1].condition).toBe("Second condition")
  })

  test("skips gates without blocked line", () => {
    const content = "<HARD-GATE>\njust some text\n</HARD-GATE>"
    expect(HardGate.parse(content)).toEqual([])
  })
})

describe("HardGate.check", () => {
  test("returns gate that blocks a given tool", () => {
    const gates: HardGate.Gate[] = [
      { condition: "no bash", blocked: ["bash"] },
      { condition: "no write", blocked: ["write"] },
    ]
    const result = HardGate.check(gates, ["bash"])
    expect(result).toBeDefined()
    expect(result?.blocked).toContain("bash")
  })

  test("returns first matching gate when multiple match", () => {
    const gates: HardGate.Gate[] = [
      { condition: "first", blocked: ["bash"] },
      { condition: "second", blocked: ["bash"] },
    ]
    const result = HardGate.check(gates, ["bash"])
    expect(result?.condition).toBe("first")
  })

  test("returns undefined when no gate blocks", () => {
    const gates: HardGate.Gate[] = [{ condition: "no bash", blocked: ["bash"] }]
    expect(HardGate.check(gates, ["read"])).toBeUndefined()
  })

  test("returns undefined for empty gates", () => {
    expect(HardGate.check([], ["bash"])).toBeUndefined()
  })
})

describe("HardGate.format", () => {
  test("produces valid XML output", () => {
    const gates: HardGate.Gate[] = [{ condition: "No shell access", blocked: ["bash", "python"] }]
    const out = HardGate.format(gates)
    expect(out).toContain("<hard-gates>")
    expect(out).toContain("</hard-gates>")
    expect(out).toContain("<hard-gate>")
    expect(out).toContain("</hard-gate>")
    expect(out).toContain("blocked: bash, python")
    expect(out).toContain("No shell access")
  })

  test("returns empty string for empty gates", () => {
    expect(HardGate.format([])).toBe("")
  })

  test("includes all gates in output", () => {
    const gates: HardGate.Gate[] = [
      { condition: "cond-a", blocked: ["bash"] },
      { condition: "cond-b", blocked: ["write"] },
    ]
    const out = HardGate.format(gates)
    expect(out).toContain("cond-a")
    expect(out).toContain("cond-b")
    expect(out).toContain("blocked: bash")
    expect(out).toContain("blocked: write")
  })
})
