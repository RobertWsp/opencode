import { Parser, Language } from "web-tree-sitter"
import path from "path"
import { createRequire } from "module"
import { Log } from "../../util/log"

const log = Log.create({ service: "plugin.code-graph.parsers" })
const req = createRequire(import.meta.url)

const LANGS: Record<string, { pkg: string; wasm: string }> = {
  ts: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" },
  tsx: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" },
  js: { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
  jsx: { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
  py: { pkg: "tree-sitter-python", wasm: "tree-sitter-python.wasm" },
  go: { pkg: "tree-sitter-go", wasm: "tree-sitter-go.wasm" },
  rs: { pkg: "tree-sitter-rust", wasm: "tree-sitter-rust.wasm" },
}

const cache = new Map<string, Parser>()
let initPromise: Promise<void> | null = null

function dir(pkg: string) {
  return path.dirname(req.resolve(`${pkg}/package.json`))
}

function ensureInit() {
  if (initPromise) return initPromise
  const wasm = path.join(dir("web-tree-sitter"), "tree-sitter.wasm")
  initPromise = Parser.init({ locateFile: () => wasm })
  return initPromise
}

export async function getParser(lang: string): Promise<Parser | null> {
  const cfg = LANGS[lang]
  if (!cfg) return null
  const wasm = path.join(dir(cfg.pkg), cfg.wasm)
  const hit = cache.get(wasm)
  if (hit) return hit
  await ensureInit()
  const language = await Language.load(wasm).catch((err: unknown) => {
    log.warn("wasm-load-failed", { lang, wasm, err: String(err) })
    return null
  })
  if (!language) return null
  const parser = new Parser()
  parser.setLanguage(language)
  cache.set(wasm, parser)
  return parser
}

export function resetParsers() {
  cache.clear()
  initPromise = null
}
