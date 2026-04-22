import { describe, it, expect, beforeEach } from "bun:test"
import { CavemanState } from "./caveman-state"

beforeEach(() => {
  CavemanState._reset()
})

describe("CavemanState", () => {
  it("reports disabled=false for unknown sessions", () => {
    expect(CavemanState.disabled("ses_unknown")).toBe(false)
  })

  it("disable → disabled returns true", () => {
    CavemanState.disable("ses_a")
    expect(CavemanState.disabled("ses_a")).toBe(true)
  })

  it("enable flips disabled → false", () => {
    CavemanState.disable("ses_a")
    expect(CavemanState.disabled("ses_a")).toBe(true)
    CavemanState.enable("ses_a")
    expect(CavemanState.disabled("ses_a")).toBe(false)
  })

  it("clear forgets the session entirely", () => {
    CavemanState.disable("ses_a")
    CavemanState.clear("ses_a")
    expect(CavemanState.disabled("ses_a")).toBe(false)
  })

  it("isolates sessions", () => {
    CavemanState.disable("ses_a")
    expect(CavemanState.disabled("ses_b")).toBe(false)
  })

  it("touch is safe to call and does not throw", () => {
    for (let i = 0; i < 250; i++) CavemanState.touch()
    expect(CavemanState.disabled("ses_x")).toBe(false)
  })

  it("child inherits disabled from a single-level ancestor", () => {
    CavemanState.disable("ses_parent")
    expect(CavemanState.disabled("ses_child", ["ses_parent"])).toBe(true)
    expect(CavemanState.disabled("ses_child")).toBe(false)
  })

  it("child inherits disabled from deep ancestor chain", () => {
    CavemanState.disable("ses_root")
    expect(CavemanState.disabled("ses_leaf", ["ses_mid", "ses_root"])).toBe(true)
  })

  it("child stays enabled when all ancestors are enabled", () => {
    CavemanState.enable("ses_parent")
    expect(CavemanState.disabled("ses_child", ["ses_parent"])).toBe(false)
  })

  it("re-enable on child does NOT override disabled ancestor (ancestor wins)", () => {
    CavemanState.disable("ses_parent")
    CavemanState.enable("ses_child")
    expect(CavemanState.disabled("ses_child", ["ses_parent"])).toBe(true)
  })
})
