export function rrfMerge(
  rankings: Array<Map<string, number>>,
  k: number = 60,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const map of rankings) {
    const sorted = [...map.entries()].sort((a, b) => b[1] - a[1])
    let i = 0
    while (i < sorted.length) {
      let j = i
      const val = sorted[i][1]
      while (j < sorted.length - 1 && sorted[j + 1][1] === val) j++
      const contrib = 1 / (i + 1 + k)
      for (let m = i; m <= j; m++) out.set(sorted[m][0], (out.get(sorted[m][0]) ?? 0) + contrib)
      i = j + 1
    }
  }
  return out
}
