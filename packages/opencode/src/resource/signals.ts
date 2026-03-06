/**
 * Project signal scanner — detects project type by checking for specific files.
 * All checks run in parallel via Promise.all.
 */

const FILES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Dockerfile", ".github", "Makefile", "pom.xml"]

async function exists(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(path).stat()
    return stat !== null
  } catch {
    return false
  }
}

export async function scan(dir: string): Promise<{ signals: string[] }> {
  const checks = FILES.map(async (file) => {
    const found = await exists(`${dir}/${file}`)
    return found ? file : null
  })

  const results = await Promise.all(checks)
  const signals = results.filter((f): f is string => f !== null)

  return { signals }
}
