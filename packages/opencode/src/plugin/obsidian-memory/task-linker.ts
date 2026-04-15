// Matches PROJ-123 (2+ uppercase chars + dash + digits) and #456 (hash + digits).
const TASK_PATTERN = /(?:^|\s)([A-Z][A-Z0-9]+-\d+|#\d+)(?=\s|$|[,.])/g

export function extractTaskRefs(text: string): string[] {
  if (!text) return []
  const refs = new Set<string>()
  const re = new RegExp(TASK_PATTERN.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) refs.add(m[1])
  return [...refs]
}

export function enrichWithTaskRefs(meta: Record<string, string>, summary: string): Record<string, string> {
  const refs = extractTaskRefs(summary)
  if (refs.length === 0) return meta
  const prev = meta.task ? meta.task.split(",").map((s) => s.trim()).filter(Boolean) : []
  const task = [...new Set([...prev, ...refs])].join(",")
  return { ...meta, task }
}
