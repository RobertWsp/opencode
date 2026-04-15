import { promises as fs } from "fs"
import path from "path"
import type { MemoryKind, Scope } from "./types"
import { loadAll, writeNote } from "./vault"

const MAX_FILE_BYTES = 10_000
const MAX_NOTE_BYTES = 2_000

export const PROJECT_FILES = [
  "README.md",
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "Dockerfile",
  "docker-compose.yml",
  ".env.example",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  "biome.json",
  "vitest.config.ts",
  "jest.config.ts",
  "ruff.toml",
]

export async function detectProjectFiles(
  worktree: string,
): Promise<Array<{ name: string; content: string }>> {
  return (
    await Promise.all(
      PROJECT_FILES.map(async (name) => {
        const f = Bun.file(path.join(worktree, name))
        if (!(await f.exists())) return null
        return { name, content: (await f.text()).slice(0, MAX_FILE_BYTES) }
      }),
    )
  ).filter((r): r is { name: string; content: string } => r !== null)
}

export async function shouldAutoInit(scope: Scope, worktree: string): Promise<boolean> {
  if (await Bun.file(path.join(scope.branchDir, ".init")).exists()) return false
  const docs = await loadAll(scope, 1)
  if (docs.notes.length > 0) return false
  if (docs.systemShared || docs.repoShared || docs.branchShared) return false
  return true
}

function kindFor(name: string): MemoryKind {
  if (name === "README.md") return "architecture"
  if (name === "CLAUDE.md" || name === "AGENTS.md" || name === ".cursorrules" || name === ".env.example")
    return "convention"
  return "tech-context"
}

function titleFor(name: string): string {
  if (name === "README.md") return "Project Overview"
  if (name === "package.json") return "Tech Stack"
  if (name === "CLAUDE.md" || name === "AGENTS.md") return "Dev Conventions"
  if (name === ".cursorrules") return "Cursor Rules"
  if (name === ".env.example") return "Environment Config"
  return name
}

function extractPackageJson(content: string): string {
  let pkg: Record<string, unknown> = {}
  try {
    pkg = JSON.parse(content) as Record<string, unknown>
  } catch {
    return content.slice(0, MAX_NOTE_BYTES)
  }
  const out: string[] = []
  if (typeof pkg.name === "string") out.push(`name: ${pkg.name}`)
  if (typeof pkg.description === "string") out.push(`description: ${pkg.description}`)
  if (typeof pkg.dependencies === "object" && pkg.dependencies !== null)
    out.push(`dependencies: ${Object.keys(pkg.dependencies as Record<string, unknown>).join(", ")}`)
  if (typeof pkg.devDependencies === "object" && pkg.devDependencies !== null)
    out.push(`devDependencies: ${Object.keys(pkg.devDependencies as Record<string, unknown>).join(", ")}`)
  if (typeof pkg.scripts === "object" && pkg.scripts !== null)
    out.push(`scripts: ${Object.keys(pkg.scripts as Record<string, unknown>).join(", ")}`)
  return out.join("\n").slice(0, MAX_NOTE_BYTES)
}

export function buildInitNotes(
  files: Array<{ name: string; content: string }>,
): Array<{ name: string; title: string; kind: MemoryKind; body: string }> {
  return files.map((f) => ({
    name: f.name,
    title: titleFor(f.name),
    kind: kindFor(f.name),
    body:
      f.name === "package.json"
        ? extractPackageJson(f.content)
        : f.content.split("\n").slice(0, 50).join("\n").slice(0, MAX_NOTE_BYTES),
  }))
}

export async function markInitDone(scope: Scope): Promise<void> {
  await fs.mkdir(scope.branchDir, { recursive: true })
  await fs.writeFile(path.join(scope.branchDir, ".init"), "", "utf8")
}

export async function runAutoInit(scope: Scope, worktree: string): Promise<number> {
  const notes = buildInitNotes(await detectProjectFiles(worktree))
  await Promise.all(
    notes.map((n) =>
      writeNote(scope, {
        title: n.title,
        meta: { "memory-kind": n.kind },
        body: n.body,
        skipCommit: true,
      }),
    ),
  )
  await markInitDone(scope)
  return notes.length
}
