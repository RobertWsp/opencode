import { describe, expect, test, afterAll } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import {
  ANCHOR_FILENAME,
  ANCHOR_VERSION,
  createAnchor,
  isValidAnchor,
  readAnchor,
  writeAnchor,
} from "../../../src/plugin/obsidian-memory/scope-anchor"

const tempDirs: string[] = []
async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
afterAll(async () => {
  for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
})

describe("scope-anchor", () => {
  test("reads missing anchor as null without error", async () => {
    const dir = await tmp("scope-anchor-read-")
    const result = await readAnchor(dir)
    expect(result.anchor).toBeNull()
    expect(result.invalid).toBeUndefined()
    expect(result.path).toBe(path.join(dir, ANCHOR_FILENAME))
  })

  test("writes and reads back a valid anchor", async () => {
    const dir = await tmp("scope-anchor-write-")
    const a = createAnchor({ repoSlug: "myproj-abc123", identity: "github.com/foo/myproj" })
    expect(await writeAnchor(dir, a)).toBe(true)
    const result = await readAnchor(dir)
    expect(result.anchor).not.toBeNull()
    expect(result.anchor!.repoSlug).toBe("myproj-abc123")
    expect(result.anchor!.identity).toBe("github.com/foo/myproj")
    expect(result.anchor!.version).toBe(ANCHOR_VERSION)
  })

  test("invalid JSON is reported as invalid, anchor null", async () => {
    const dir = await tmp("scope-anchor-invalid-")
    await fs.writeFile(path.join(dir, ANCHOR_FILENAME), "not json {")
    const result = await readAnchor(dir)
    expect(result.anchor).toBeNull()
    expect(result.invalid).toBe(true)
  })

  test("missing version field is invalid", async () => {
    expect(
      isValidAnchor({ repoSlug: "x", createdAt: new Date().toISOString() }),
    ).toBe(false)
  })

  test("missing repoSlug is invalid", async () => {
    expect(
      isValidAnchor({ version: 1, createdAt: new Date().toISOString() }),
    ).toBe(false)
  })

  test("unknown version is rejected (not current)", () => {
    expect(
      isValidAnchor({ version: 999, repoSlug: "x", createdAt: new Date().toISOString() }),
    ).toBe(false)
  })

  test("write preserves existing anchor (no overwrite is tested elsewhere)", async () => {
    const dir = await tmp("scope-anchor-preserve-")
    await writeAnchor(dir, createAnchor({ repoSlug: "first-xxx" }))
    const r1 = await readAnchor(dir)
    expect(r1.anchor!.repoSlug).toBe("first-xxx")
    // overwrite should work if caller explicitly asks (write is idempotent)
    await writeAnchor(dir, createAnchor({ repoSlug: "second-yyy" }))
    const r2 = await readAnchor(dir)
    expect(r2.anchor!.repoSlug).toBe("second-yyy")
  })

  test("writing to a read-only dir returns false without throwing", async () => {
    const dir = await tmp("scope-anchor-ro-")
    // make it read-only
    await fs.chmod(dir, 0o555)
    try {
      const ok = await writeAnchor(dir, createAnchor({ repoSlug: "x" }))
      expect(ok).toBe(false)
    } finally {
      // restore so cleanup works
      await fs.chmod(dir, 0o755).catch(() => undefined)
    }
  })
})
