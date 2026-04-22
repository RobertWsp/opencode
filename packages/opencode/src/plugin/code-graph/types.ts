export enum NodeKind {
  File = "File",
  Class = "Class",
  Function = "Function",
  Type = "Type",
  Test = "Test",
}

export enum EdgeKind {
  CALLS = "CALLS",
  IMPORTS_FROM = "IMPORTS_FROM",
  INHERITS = "INHERITS",
  IMPLEMENTS = "IMPLEMENTS",
  CONTAINS = "CONTAINS",
  TESTED_BY = "TESTED_BY",
  DEPENDS_ON = "DEPENDS_ON",
  REFERENCES = "REFERENCES",
}

export type Language = "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rs"

export interface GraphNode {
  id: string
  kind: NodeKind
  name: string
  qualifiedName: string
  filePath: string
  lineStart: number
  lineEnd: number
  language: Language
  parentName?: string
  signature?: string
  isTest: boolean
  fileHash: string
  extra?: Record<string, unknown>
  updatedAt: number
}

export interface GraphEdge {
  kind: EdgeKind
  srcQualifiedName: string
  tgtQualifiedName: string
  filePath: string
  lineNumber: number
  confidence: "certain" | "inferred"
}
