/**
 * Project signal scanner — detects project type by checking for specific files.
 * Runs all 8 file checks in parallel via Promise.all.
 * Returns only the names of files/directories that exist.
 */

const SIGNALS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Dockerfile",
  ".github",
  "Makefile",
  "pom.xml",
]

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat()
    return true
  } catch {
    return false
  }
}

export async function scan(dir: string): Promise<{ signals: string[] }> {
  const checks = SIGNALS.map((file) => fileExists(`${dir}/${file}`).then((found) => (found ? file : null)))
  const results = await Promise.all(checks)
  const signals = results.filter((f): f is string => f !== null)
  return { signals }
}
