import type { Node, Tree } from "web-tree-sitter"
import { NodeKind, EdgeKind } from "./types"
import type { GraphNode, GraphEdge, Language } from "./types"

export interface ExtractResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

interface LangCfg {
  declKinds: Record<string, NodeKind>
  nameField: string
  altNameField?: string
  importTypes: string[]
  importSourceField: string
  classBodyType?: string
  methodTypes?: string[]
}

const TS_CFG: LangCfg = {
  declKinds: {
    function_declaration: NodeKind.Function,
    generator_function_declaration: NodeKind.Function,
    class_declaration: NodeKind.Class,
    interface_declaration: NodeKind.Type,
    type_alias_declaration: NodeKind.Type,
    enum_declaration: NodeKind.Type,
    abstract_class_declaration: NodeKind.Class,
  },
  nameField: "name",
  importTypes: ["import_statement"],
  importSourceField: "source",
  classBodyType: "class_body",
  methodTypes: ["method_definition", "public_field_definition"],
}

const JS_CFG: LangCfg = {
  declKinds: {
    function_declaration: NodeKind.Function,
    generator_function_declaration: NodeKind.Function,
    class_declaration: NodeKind.Class,
  },
  nameField: "name",
  importTypes: ["import_statement"],
  importSourceField: "source",
  classBodyType: "class_body",
  methodTypes: ["method_definition"],
}

const PY_CFG: LangCfg = {
  declKinds: {
    function_definition: NodeKind.Function,
    class_definition: NodeKind.Class,
  },
  nameField: "name",
  importTypes: ["import_statement", "import_from_statement"],
  importSourceField: "name",
  classBodyType: "block",
  methodTypes: ["function_definition"],
}

const GO_CFG: LangCfg = {
  declKinds: {
    function_declaration: NodeKind.Function,
    method_declaration: NodeKind.Function,
    type_spec: NodeKind.Type,
  },
  nameField: "name",
  importTypes: ["import_declaration", "import_spec"],
  importSourceField: "path",
}

const RS_CFG: LangCfg = {
  declKinds: {
    function_item: NodeKind.Function,
    struct_item: NodeKind.Class,
    enum_item: NodeKind.Type,
    trait_item: NodeKind.Type,
    impl_item: NodeKind.Class,
    type_item: NodeKind.Type,
  },
  nameField: "name",
  importTypes: ["use_declaration"],
  importSourceField: "argument",
}

const LANG_CFGS: Record<string, LangCfg> = {
  ts: TS_CFG,
  tsx: TS_CFG,
  js: JS_CFG,
  jsx: JS_CFG,
  py: PY_CFG,
  go: GO_CFG,
  rs: RS_CFG,
}

function qualName(filePath: string, name: string, parent?: string) {
  return parent ? `${filePath}::${parent}.${name}` : `${filePath}::${name}`
}

function makeNode(
  kind: NodeKind,
  name: string,
  qn: string,
  node: Node,
  filePath: string,
  fileHash: string,
  lang: Language,
  parent?: string,
): GraphNode {
  return {
    id: qn,
    kind,
    name,
    qualifiedName: qn,
    filePath,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    language: lang,
    isTest: /[._-]test\.|[._-]spec\./.test(filePath),
    fileHash,
    updatedAt: Date.now(),
    parentName: parent,
  }
}

function extractName(node: Node, cfg: LangCfg): string | null {
  const n = node.childForFieldName(cfg.nameField) ?? (cfg.altNameField ? node.childForFieldName(cfg.altNameField) : null)
  return n?.text ?? null
}

function extractDecl(
  node: Node,
  cfg: LangCfg,
  filePath: string,
  fileHash: string,
  lang: Language,
  parent?: string,
): GraphNode | null {
  const kind = cfg.declKinds[node.type]
  if (!kind) return null
  const name = extractName(node, cfg)
  if (!name) return null
  const qn = qualName(filePath, name, parent)
  return makeNode(kind, name, qn, node, filePath, fileHash, lang, parent)
}

function unwrapExport(node: Node): Node {
  if (node.type !== "export_statement") return node
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!
    if (child.type !== "export" && child.type !== "default" && child.type !== "declare") return child
  }
  return node
}

function extractImports(node: Node, cfg: LangCfg, filePath: string): GraphEdge[] {
  if (!cfg.importTypes.includes(node.type)) return []
  const src = node.childForFieldName(cfg.importSourceField)
  if (!src) return []
  const raw = src.text.replace(/^["']|["']$/g, "")
  return [{
    kind: EdgeKind.IMPORTS_FROM,
    srcQualifiedName: filePath,
    tgtQualifiedName: raw,
    filePath,
    lineNumber: node.startPosition.row + 1,
    confidence: "certain",
  }]
}

function extractClassMembers(
  classNode: Node,
  className: string,
  cfg: LangCfg,
  filePath: string,
  fileHash: string,
  lang: Language,
): GraphNode[] {
  if (!cfg.classBodyType || !cfg.methodTypes) return []
  const body = classNode.childForFieldName("body")
  if (!body || body.type !== cfg.classBodyType) return []
  const out: GraphNode[] = []
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i)!
    if (!cfg.methodTypes.includes(child.type)) continue
    const name = extractName(child, cfg)
    if (!name || name === "constructor") continue
    out.push(makeNode(NodeKind.Function, name, qualName(filePath, name, className), child, filePath, fileHash, lang, className))
  }
  return out
}

function extractLexicalArrows(
  node: Node,
  filePath: string,
  fileHash: string,
  lang: Language,
): GraphNode[] {
  if (node.type !== "lexical_declaration") return []
  const out: GraphNode[] = []
  for (let i = 0; i < node.childCount; i++) {
    const decl = node.child(i)!
    if (decl.type !== "variable_declarator") continue
    const nameNode = decl.childForFieldName("name")
    const val = decl.childForFieldName("value")
    if (!nameNode || !val) continue
    if (val.type !== "arrow_function" && val.type !== "function_expression") continue
    const name = nameNode.text
    const qn = qualName(filePath, name)
    out.push(makeNode(NodeKind.Function, name, qn, node, filePath, fileHash, lang))
  }
  return out
}

export function extract(tree: Tree, filePath: string, fileHash: string, lang: string): ExtractResult {
  const cfg = LANG_CFGS[lang]
  if (!cfg) return { nodes: [], edges: [] }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const root = tree.rootNode

  for (let i = 0; i < root.childCount; i++) {
    const raw = root.child(i)!
    const node = unwrapExport(raw)

    edges.push(...extractImports(raw, cfg, filePath))
    edges.push(...extractImports(node, cfg, filePath))

    const decl = extractDecl(node, cfg, filePath, fileHash, lang as Language)
    if (decl) {
      nodes.push(decl)
      if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
        nodes.push(...extractClassMembers(node, decl.name, cfg, filePath, fileHash, lang as Language))
      }
      continue
    }

    nodes.push(...extractLexicalArrows(node, filePath, fileHash, lang as Language))
  }

  return { nodes, edges }
}
