#!/usr/bin/env bun
import { Plugin } from "../src/plugin"

const MS = 1000
const TOLERANCE = 500

const start = Date.now()
const result = await Plugin.withTimeout(
  "smoke",
  () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 40_000)),
  MS,
)
const elapsed = Date.now() - start

console.log(`elapsed=${elapsed}ms expected=${MS}ms tolerance=±${TOLERANCE}ms result=${String(result)}`)

if (result !== undefined) {
  console.log(`FAIL: expected undefined on timeout, got ${String(result)}`)
  process.exit(1)
}

if (elapsed < MS - TOLERANCE || elapsed > MS + TOLERANCE) {
  console.log(`FAIL: elapsed ${elapsed}ms outside [${MS - TOLERANCE}, ${MS + TOLERANCE}]`)
  process.exit(1)
}

console.log(`PASS: withTimeout aborted after ~${elapsed}ms (target ${MS}ms)`)
process.exit(0)
