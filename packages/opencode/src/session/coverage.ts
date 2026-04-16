export namespace Coverage {
  const store = new Map<string, Map<string, Set<number>>>()

  function files_map(session: string): Map<string, Set<number>> {
    if (!store.has(session)) store.set(session, new Map())
    return store.get(session)!
  }

  export function record(session: string, filepath: string, offset: number, limit: number): void {
    const map = files_map(session)
    if (!map.has(filepath)) map.set(filepath, new Set())
    const set = map.get(filepath)!
    for (let i = offset; i < offset + limit; i++) set.add(i)
  }

  export function files(session: string): string[] {
    return Array.from(files_map(session).keys())
  }

  export function lines(session: string, filepath: string): number[] {
    return Array.from(files_map(session).get(filepath) ?? []).sort((a, b) => a - b)
  }

  export function percentage(session: string, filepath: string, total: number): number {
    if (total === 0) return 0
    const count = files_map(session).get(filepath)?.size ?? 0
    return Math.min(100, (count / total) * 100)
  }

  export function clear(session: string): void {
    store.delete(session)
  }

  export function format(session: string): string {
    const map = files_map(session)
    if (map.size === 0) return "no files read"
    const lines: string[] = []
    for (const [filepath, set] of map.entries()) {
      lines.push(`  ${filepath}: ${set.size} lines`)
    }
    return `files read (${map.size}):\n${lines.join("\n")}`
  }
}
