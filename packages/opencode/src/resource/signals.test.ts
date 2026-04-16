import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { scan } from "./signals"

describe("scan", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-test-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("detects package.json", async () => {
    await Bun.write(join(dir, "package.json"), "{}")
    const result = await scan(dir)
    expect(result.signals).toContain("package.json")
  })

  it("detects pyproject.toml", async () => {
    await Bun.write(join(dir, "pyproject.toml"), "")
    const result = await scan(dir)
    expect(result.signals).toContain("pyproject.toml")
  })

  it("detects Cargo.toml", async () => {
    await Bun.write(join(dir, "Cargo.toml"), "")
    const result = await scan(dir)
    expect(result.signals).toContain("Cargo.toml")
  })

  it("detects go.mod", async () => {
    await Bun.write(join(dir, "go.mod"), "")
    const result = await scan(dir)
    expect(result.signals).toContain("go.mod")
  })

  it("detects Dockerfile", async () => {
    await Bun.write(join(dir, "Dockerfile"), "")
    const result = await scan(dir)
    expect(result.signals).toContain("Dockerfile")
  })

  it("detects .github directory", async () => {
    await Bun.write(join(dir, ".github", "workflows", "test.yml"), "")
    const result = await scan(dir)
    expect(result.signals).toContain(".github")
  })

  it("detects Makefile", async () => {
    await Bun.write(join(dir, "Makefile"), "")
    const result = await scan(dir)
    expect(result.signals).toContain("Makefile")
  })

  it("detects pom.xml", async () => {
    await Bun.write(join(dir, "pom.xml"), "")
    const result = await scan(dir)
    expect(result.signals).toContain("pom.xml")
  })

  it("returns empty signals for unknown project", async () => {
    const result = await scan(dir)
    expect(result.signals).toEqual([])
  })

  it("returns only detected signals", async () => {
    await Bun.write(join(dir, "package.json"), "{}")
    await Bun.write(join(dir, "Makefile"), "")
    const result = await scan(dir)
    expect(result.signals).toHaveLength(2)
    expect(result.signals).toContain("package.json")
    expect(result.signals).toContain("Makefile")
  })

  it("completes in less than 50ms", async () => {
    await Bun.write(join(dir, "package.json"), "{}")
    const start = performance.now()
    await scan(dir)
    const duration = performance.now() - start
    expect(duration).toBeLessThan(50)
  })
})
