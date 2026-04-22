import { test, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import os from "os"
import { loadRegistryState, saveRegistryState, isPluginEnabled, BUILTIN_PLUGINS } from "./registry"

let tmp: string

beforeEach(async () => {
  tmp = path.join(os.tmpdir(), `registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await Bun.$`mkdir -p ${tmp}`.quiet()
  process.env.OPENCODE_TEST_HOME = tmp
})

afterEach(async () => {
  delete process.env.OPENCODE_TEST_HOME
  await Bun.$`rm -rf ${tmp}`.quiet()
})

test("loadRegistryState returns {} for missing file", async () => {
  expect(await loadRegistryState()).toEqual({})
})

test("round-trip save→load preserves state", async () => {
  const state = { "obsidian-memory": false, caveman: true }
  await saveRegistryState(state)
  expect(await loadRegistryState()).toEqual(state)
})

test("loadRegistryState returns {} on malformed JSON", async () => {
  const target = path.join(tmp, ".config", "opencode", "plugins.json")
  await Bun.$`mkdir -p ${path.dirname(target)}`.quiet()
  await Bun.write(target, "not-json{{{")
  expect(await loadRegistryState()).toEqual({})
})

test("isPluginEnabled uses state override over default", async () => {
  await saveRegistryState({ caveman: true })
  expect(await isPluginEnabled("caveman")).toBe(true)
})

test("isPluginEnabled caveman defaults to false", async () => {
  expect(await isPluginEnabled("caveman")).toBe(false)
})

test("isPluginEnabled disable via override then reload", async () => {
  await saveRegistryState({ caveman: false })
  expect(await isPluginEnabled("caveman")).toBe(false)
})

test("isPluginEnabled obsidian-memory defaults to true", async () => {
  expect(await isPluginEnabled("obsidian-memory")).toBe(true)
})

test("isPluginEnabled unknown plugin defaults to true", async () => {
  expect(await isPluginEnabled("unknown-plugin-xyz")).toBe(true)
})

test("BUILTIN_PLUGINS descriptors are correct", () => {
  const obsidian = BUILTIN_PLUGINS.find((p) => p.name === "obsidian-memory")
  expect(obsidian?.defaultEnabled).toBe(true)
  expect(obsidian?.category).toBe("memory")

  const caveman = BUILTIN_PLUGINS.find((p) => p.name === "caveman")
  expect(caveman?.defaultEnabled).toBe(false)
  expect(caveman?.category).toBe("output")

  const graph = BUILTIN_PLUGINS.find((p) => p.name === "code-graph")
  expect(graph?.defaultEnabled).toBe(true)
  expect(graph?.category).toBe("codebase")
})
