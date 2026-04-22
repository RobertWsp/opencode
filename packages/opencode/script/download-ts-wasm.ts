#!/usr/bin/env bun
import path from "path"
import fs from "fs/promises"
import { createRequire } from "module"
import { xdgCache } from "xdg-basedir"

const req = createRequire(import.meta.url)
const dest = path.join(xdgCache!, "opencode", "code-graph", "wasm")

const ENTRIES: { pkg: string; wasm: string }[] = [
  { pkg: "web-tree-sitter", wasm: "tree-sitter.wasm" },
  { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" },
  { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" },
  { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
  { pkg: "tree-sitter-python", wasm: "tree-sitter-python.wasm" },
  { pkg: "tree-sitter-go", wasm: "tree-sitter-go.wasm" },
  { pkg: "tree-sitter-rust", wasm: "tree-sitter-rust.wasm" },
]

await fs.mkdir(dest, { recursive: true })

for (const { pkg, wasm } of ENTRIES) {
  const src = path.join(path.dirname(req.resolve(`${pkg}/package.json`)), wasm)
  const out = path.join(dest, wasm)
  await fs.copyFile(src, out)
  console.log(`copied ${wasm}`)
}

console.log(`done → ${dest}`)
