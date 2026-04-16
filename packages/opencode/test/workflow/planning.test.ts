import { describe, expect, test } from "bun:test"
import path from "path"
import { Planning } from "../../src/workflow/planning"
import { tmpdir } from "../fixture/fixture"

describe("workflow.planning", () => {
  describe("DIR", () => {
    test("is correct constant", () => {
      expect(Planning.DIR).toBe(".opencode/planning")
    })
  })

  describe("init", () => {
    test("creates directory structure", async () => {
      await using tmp = await tmpdir()
      await Planning.init(tmp.path)
      const dir = path.join(tmp.path, Planning.DIR)
      const check = (p: string) =>
        Bun.file(p)
          .exists()
          .then((v) => v)
      expect(await check(dir + "/CONTEXT.md")).toBe(true)
      expect(await check(dir + "/PLAN.md")).toBe(true)
      expect(await check(dir + "/STATUS.md")).toBe(true)
    })
  })

  describe("writePlan + plan", () => {
    test("round-trip", async () => {
      await using tmp = await tmpdir()
      await Planning.init(tmp.path)
      await Planning.writePlan(tmp.path, "# My Plan\n")
      expect(await Planning.plan(tmp.path)).toBe("# My Plan\n")
    })
  })

  describe("writeStatus + status", () => {
    test("round-trip", async () => {
      await using tmp = await tmpdir()
      await Planning.init(tmp.path)
      await Planning.writeStatus(tmp.path, "# Status\ndone\n")
      expect(await Planning.status(tmp.path)).toBe("# Status\ndone\n")
    })
  })

  describe("addDecision", () => {
    test("auto-increments ID", async () => {
      await using tmp = await tmpdir()
      await Planning.init(tmp.path)
      const d1 = await Planning.addDecision(tmp.path, { title: "First", rationale: "Because", locked: false })
      const d2 = await Planning.addDecision(tmp.path, { title: "Second", rationale: "Also", locked: false })
      expect(d1.id).toBe("D-01")
      expect(d2.id).toBe("D-02")
    })

    test("with locked=true", async () => {
      await using tmp = await tmpdir()
      await Planning.init(tmp.path)
      const d = await Planning.addDecision(tmp.path, { title: "Locked", rationale: "Final", locked: true })
      expect(d.locked).toBe(true)
    })
  })

  describe("decisions", () => {
    test("parses stored decisions", async () => {
      await using tmp = await tmpdir()
      await Planning.init(tmp.path)
      await Planning.addDecision(tmp.path, { title: "Use TypeScript", rationale: "Type safety", locked: false })
      await Planning.addDecision(tmp.path, { title: "Use Bun", rationale: "Speed", locked: true })
      const list = await Planning.decisions(tmp.path)
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe("D-01")
      expect(list[0].title).toBe("Use TypeScript")
      expect(list[1].id).toBe("D-02")
      expect(list[1].locked).toBe(true)
    })
  })
})
