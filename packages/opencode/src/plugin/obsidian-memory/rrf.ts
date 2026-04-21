export function rrfMerge(
  rankings: Array<Map<string, number>>,
  k: number = 60,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const map of rankings) {
    const sorted = [...map.entries()].sort((a, b) => b[1] - a[1])
    sorted.forEach(([id], rank) => {
      out.set(id, (out.get(id) ?? 0) + 1 / (rank + 1 + k))
    })
  }
  return out
}
