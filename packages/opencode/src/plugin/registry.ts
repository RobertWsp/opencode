import path from "path"
import { xdgConfig } from "xdg-basedir"

export type BuiltinPluginDescriptor = {
  name: string
  displayName: string
  description: string
  defaultEnabled: boolean
  category: "memory" | "codebase" | "output" | "dev"
}

export const BUILTIN_PLUGINS: BuiltinPluginDescriptor[] = [
  {
    name: "obsidian-memory",
    displayName: "Obsidian Memory",
    description: "Persistent memory via Obsidian vault",
    defaultEnabled: true,
    category: "memory",
  },
  {
    name: "caveman",
    displayName: "Caveman Mode",
    description: "Terse output mode",
    defaultEnabled: false,
    category: "output",
  },
  {
    name: "code-graph",
    displayName: "Code Graph",
    description: "SQLite-backed code graph with tree-sitter",
    defaultEnabled: true,
    category: "codebase",
  },
]

export type RegistryState = Record<string, boolean>

function cfgDir() {
  if (process.env.OPENCODE_TEST_HOME)
    return path.join(process.env.OPENCODE_TEST_HOME, ".config", "opencode")
  return path.join(xdgConfig!, "opencode")
}

function pluginsJson() {
  return path.join(cfgDir(), "plugins.json")
}

export async function loadRegistryState(): Promise<RegistryState> {
  const file = Bun.file(pluginsJson())
  if (!(await file.exists())) return {}
  return (file.json() as Promise<RegistryState>).catch(() => ({}))
}

export async function saveRegistryState(state: RegistryState): Promise<void> {
  const target = pluginsJson()
  await Bun.$`mkdir -p ${path.dirname(target)}`.quiet()
  const tmp = target + ".tmp"
  await Bun.write(tmp, JSON.stringify(state, null, 2))
  await Bun.$`mv -f ${tmp} ${target}`.quiet()
}

export async function isPluginEnabled(name: string): Promise<boolean> {
  const state = await loadRegistryState()
  if (name in state) return state[name]
  const descriptor = BUILTIN_PLUGINS.find((p) => p.name === name)
  if (descriptor) return descriptor.defaultEnabled
  return true
}
