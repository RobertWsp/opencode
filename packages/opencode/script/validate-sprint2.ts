#!/usr/bin/env bun
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { detectContradiction, markSuperseded } from "../src/plugin/obsidian-memory/contradiction"
import { findSimilarSlugs } from "../src/plugin/obsidian-memory/capture-gate"
import { parseFrontmatter, serializeFrontmatter } from "../src/plugin/obsidian-memory/frontmatter"
import { toEntry } from "../src/plugin/obsidian-memory/parse-entry"
import type { MemoryDoc, MemoryEntry } from "../src/plugin/obsidian-memory/types"

const tmpDir = path.join(os.tmpdir(), `sprint2-valid-${Date.now()}`)
await fs.mkdir(tmpDir, { recursive: true })

function mkEntry(filepath: string, title: string, body: string, meta: Record<string, string> = {}): MemoryEntry {
  const doc: MemoryDoc = {
    path: filepath,
    meta: { title, "memory-kind": "decision", tags: "auth,security", ...meta },
    body,
    mtimeMs: Date.now(),
    size: body.length,
  }
  return toEntry(doc)
}

console.log("# Sprint 2 E2E validation — direct function calls\n")
console.log(`working dir: ${tmpDir}\n`)

const oldPath = path.join(tmpDir, "jwt-auth.md")
const oldContent = serializeFrontmatter(
  { title: "JWT Auth", "memory-kind": "decision", tags: "auth,security" },
  "We use JWT tokens for authentication. Short-lived access tokens + refresh tokens. Secret stored in env.",
)
await fs.writeFile(oldPath, oldContent)
const oldParsed = parseFrontmatter(await fs.readFile(oldPath, "utf8"))
const oldEntry = mkEntry(oldPath, "JWT Auth", oldParsed.body)
console.log(`created OLD note: ${oldPath}`)

const newEntry = mkEntry(
  path.join(tmpDir, "session-auth.md"),
  "Session auth",
  "Auth changed: JWT tokens are now deprecated. We replaced JWT with HTTP session cookies. Legacy JWT code removed.",
)

console.log("\n## 1a. findSimilarSlugs — overlapping body (should link)\n")
const overlapBody = "We use JWT tokens for authentication. Short-lived access tokens + refresh tokens. Auth module centralized."
const overlapEntry = mkEntry(path.join(tmpDir, "auth-overlap.md"), "Auth overlap", overlapBody)
const slugsA = findSimilarSlugs(
  { title: overlapEntry.title, body: overlapEntry.doc.body },
  [oldEntry],
  0.15,
  3,
)
console.log(`result: [${slugsA.join(", ")}]`)
console.log(`PASS: ${slugsA.includes("jwt-auth") ? "✅" : "❌"}`)

console.log("\n## 1b. findSimilarSlugs — moderate overlap with low threshold (0.10)\n")
const decision = { title: newEntry.title, body: newEntry.doc.body }
const slugs = findSimilarSlugs(decision, [oldEntry], 0.10, 3)
console.log(`result: [${slugs.join(", ")}]  (threshold=0.10 for sim=0.12)`)
console.log(`PASS: ${slugs.includes("jwt-auth") ? "✅" : "❌"}`)

console.log("\n## 2. detectContradiction — new has negation ('deprecated','replaced','removed') + high sim\n")
const contra = await detectContradiction(newEntry, [oldEntry], 0.15)
console.log(`result: ${JSON.stringify(contra, null, 2)}`)
console.log(`PASS: ${contra !== null && contra.path === oldPath ? "✅" : "❌"}`)

console.log("\n## 3. markSuperseded — mutates frontmatter of old note\n")
if (contra) {
  const ok = await markSuperseded(oldPath, "session-auth")
  console.log(`markSuperseded returned: ${ok}`)
  const updated = await fs.readFile(oldPath, "utf8")
  const parsed = parseFrontmatter(updated)
  console.log(`frontmatter after mark:`)
  console.log(`  valid_until: ${parsed.meta["valid_until"] ?? "(missing)"}`)
  console.log(`  superseded_by: ${parsed.meta["superseded_by"] ?? "(missing)"}`)
  const validPass = parsed.meta["valid_until"] && parsed.meta["superseded_by"] === "session-auth"
  console.log(`PASS: ${validPass ? "✅" : "❌"}`)
}

console.log("\n## 4. Negative case — same topic without negation words\n")
const harmlessEntry = mkEntry(
  path.join(tmpDir, "jwt-config.md"),
  "JWT Configuration",
  "JWT tokens use HS256 algorithm. Secret is 32 bytes. Expiration is 15 minutes.",
)
const contraNone = await detectContradiction(harmlessEntry, [oldEntry], 0.15)
console.log(`result: ${contraNone === null ? "null (correct — no contradiction)" : JSON.stringify(contraNone)}`)
console.log(`PASS: ${contraNone === null ? "✅" : "❌"}`)

console.log("\n## 5. findSimilarSlugs threshold — low sim doesn't link\n")
const unrelated = mkEntry(
  path.join(tmpDir, "unrelated.md"),
  "Database migration",
  "Run bun run db generate --name create_users. Adds users table with email, password_hash.",
)
const slugsUnrelated = findSimilarSlugs(
  { title: unrelated.title, body: unrelated.doc.body },
  [oldEntry],
  0.35,
  3,
)
console.log(`result: [${slugsUnrelated.join(", ")}]`)
console.log(`PASS: ${slugsUnrelated.length === 0 ? "✅ (no false-positive link)" : "❌ (false positive)"}`)

await fs.rm(tmpDir, { recursive: true })
console.log(`\ncleanup: removed ${tmpDir}`)
