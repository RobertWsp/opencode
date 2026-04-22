import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { openDb } from "../db"
import { ingestDir, ingestFile } from "../ingest"
import { parseCodeGraphConfig } from "../config"
import { resetParsers } from "../parsers"

const dirs: string[] = []

function tmpSetup() {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-ingest-"))
  dirs.push(dir)
  const db = openDb(path.join(dir, "test.db"))
  return { dir, db }
}

afterEach(async () => {
  await resetParsers()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

const cfg = parseCodeGraphConfig({})

describe("ingestFile", () => {
  test("returns added for new file", async () => {
    const { dir, db } = tmpSetup()
    const file = path.join(dir, "a.ts")
    writeFileSync(file, "export function hello() {}")
    expect(await ingestFile(db, file, "ts")).toBe("added")
    db.close()
  })

  test("returns skipped on unchanged file", async () => {
    const { dir, db } = tmpSetup()
    const file = path.join(dir, "a.ts")
    writeFileSync(file, "export function hello() {}")
    await ingestFile(db, file, "ts")
    expect(await ingestFile(db, file, "ts")).toBe("skipped")
    db.close()
  })

  test("returns updated when content changes", async () => {
    const { dir, db } = tmpSetup()
    const file = path.join(dir, "a.ts")
    writeFileSync(file, "export function hello() {}")
    await ingestFile(db, file, "ts")
    writeFileSync(file, "export function hello() { return 42 }")
    expect(await ingestFile(db, file, "ts")).toBe("updated")
    db.close()
  })

  test("returns failed for missing file", async () => {
    const { dir, db } = tmpSetup()
    expect(await ingestFile(db, path.join(dir, "missing.ts"), "ts")).toBe("failed")
    db.close()
  })

  test("returns failed for unknown lang", async () => {
    const { dir, db } = tmpSetup()
    const file = path.join(dir, "a.ts")
    writeFileSync(file, "function x() {}")
    expect(await ingestFile(db, file, "cobol")).toBe("failed")
    db.close()
  })

  test("stores nodes in db after ingest", async () => {
    const { dir, db } = tmpSetup()
    const file = path.join(dir, "a.ts")
    writeFileSync(file, "export function greet(name: string) { return name }")
    await ingestFile(db, file, "ts")
    const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM nodes").get()!
    expect(count.c).toBeGreaterThan(0)
    db.close()
  })
})

describe("ingestDir", () => {
  test("discovers and ingests ts files", async () => {
    const { dir, db } = tmpSetup()
    writeFileSync(path.join(dir, "a.ts"), "export function a() {}")
    writeFileSync(path.join(dir, "b.ts"), "export function b() {}")
    writeFileSync(path.join(dir, "c.txt"), "ignored")
    const stats = await ingestDir(db, dir, cfg)
    expect(stats.added).toBe(2)
    expect(stats.skipped).toBe(0)
    db.close()
  })

  test("skips node_modules by default", async () => {
    const { dir, db } = tmpSetup()
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true })
    writeFileSync(path.join(dir, "node_modules", "pkg", "index.ts"), "export function x() {}")
    writeFileSync(path.join(dir, "src.ts"), "export function y() {}")
    const stats = await ingestDir(db, dir, cfg)
    expect(stats.added).toBe(1)
    db.close()
  })

  test("second pass returns all skipped", async () => {
    const { dir, db } = tmpSetup()
    writeFileSync(path.join(dir, "a.ts"), "export function a() {}")
    await ingestDir(db, dir, cfg)
    const stats2 = await ingestDir(db, dir, cfg)
    expect(stats2.skipped).toBe(1)
    expect(stats2.added).toBe(0)
    db.close()
  })
})
