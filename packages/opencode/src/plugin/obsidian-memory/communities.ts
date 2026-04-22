import Graph from "graphology"
import louvain from "graphology-communities-louvain"
import path from "path"
import type { MemoryEntry } from "./types"

export function buildCommunities(entries: MemoryEntry[]): Map<string, number> {
  if (!entries.length) return new Map()

  const graph = new Graph({ type: "undirected", multi: false, allowSelfLoops: false })

  const bySlug = new Map<string, string>()
  for (const e of entries) {
    graph.addNode(e.doc.path)
    bySlug.set(path.basename(e.doc.path, ".md").toLowerCase(), e.doc.path)
  }

  for (const e of entries) {
    for (const link of e.links) {
      const target = bySlug.get(path.basename(link, ".md").toLowerCase())
      if (!target || target === e.doc.path) continue
      if (!graph.hasEdge(e.doc.path, target)) graph.addEdge(e.doc.path, target)
    }
  }

  const result = louvain(graph) as Record<string, number>
  return new Map(Object.entries(result))
}
