#!/usr/bin/env bun
import { readFile } from "fs/promises"
import { homedir } from "os"
import path from "path"
import { Caveman } from "../src/session/caveman"

const PROMPTS = [
  { lang: "en", intent: "implementation", text: "Implement a debounce function in TypeScript with cancel/flush methods. Include JSDoc, unit tests, and usage examples." },
  { lang: "pt", intent: "implementation", text: "Implementar um hook useDebouncedState em React+TypeScript com cleanup correto. Incluir o hook, testes unitários e um exemplo de uso." },
  { lang: "en", intent: "fix", text: "Diagnose and fix: TypeError 'Cannot read property map of undefined' in UserList.tsx when API call fails. Show root cause, the patch, and how to prevent regression." },
  { lang: "pt", intent: "fix", text: "Diagnosticar e corrigir: erro 'Cannot read property map of undefined' no UserList.tsx quando o fetch falha. Mostrar causa raiz, o patch e como evitar regressão." },
]

const MODEL = "claude-haiku-4-5-20251001"
const MAX_TOKENS = 1500

type Usage = { input_tokens: number; output_tokens: number }
type Call = { ok: boolean; text: string; usage?: Usage; ms: number; error?: string }

async function creds(): Promise<{ accessToken: string } | null> {
  try {
    const raw = await readFile(path.join(homedir(), ".claude", ".credentials.json"), "utf8")
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken: string; expiresAt?: number } }
    const c = parsed.claudeAiOauth
    if (!c?.accessToken) return null
    if (c.expiresAt && c.expiresAt < Date.now() + 60_000) return null
    return c
  } catch {
    return null
  }
}

async function call(system: string, userMsg: string): Promise<Call> {
  const started = Date.now()
  const c = await creds()
  if (!c) return { ok: false, text: "", ms: Date.now() - started, error: "no credentials" }
  const oauthSystem = `You are Claude Code, Anthropic's official CLI for Claude.\n\n${system}`
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.107 (external, cli)",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: oauthSystem, messages: [{ role: "user", content: userMsg }] }),
  })
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: Usage; error?: { message: string } }
  if (!res.ok) return { ok: false, text: "", ms: Date.now() - started, error: json.error?.message ?? `HTTP ${res.status}` }
  const text = (json.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("")
  return { ok: true, text, usage: json.usage, ms: Date.now() - started }
}

const BASE_SYSTEM = "You are a helpful senior software engineer. Answer the user's question."

const configs = [
  { name: "baseline", system: BASE_SYSTEM },
  { name: "caveman:full", system: `${BASE_SYSTEM}\n\n${Caveman.hint("full")}` },
  { name: "caveman:ultra", system: `${BASE_SYSTEM}\n\n${Caveman.hint("ultra")}` },
]

async function main() {
  console.log(`# Focused bench — implementation + fix @ max_tokens=${MAX_TOKENS}`)
  const rows: { prompt: number; lang: string; intent: string; config: string; in: number; out: number; ms: number }[] = []

  for (let i = 0; i < PROMPTS.length; i++) {
    const p = PROMPTS[i]
    for (const cfg of configs) {
      process.stderr.write(`→ [${i + 1}/${PROMPTS.length}] ${cfg.name.padEnd(18)} ... `)
      const r = await call(cfg.system, p.text)
      if (!r.ok || !r.usage) {
        process.stderr.write(`FAIL: ${r.error}\n`)
        continue
      }
      rows.push({ prompt: i + 1, lang: p.lang, intent: p.intent, config: cfg.name, in: r.usage.input_tokens, out: r.usage.output_tokens, ms: r.ms })
      process.stderr.write(`in=${r.usage.input_tokens} out=${r.usage.output_tokens} ms=${r.ms}\n`)
      await new Promise((res) => setTimeout(res, 300))
    }
  }

  console.log("\n## Per-call\n")
  console.log("| # | lang | intent | config | in | out | ms |")
  console.log("|---|------|--------|--------|----|----|-----|")
  for (const r of rows) console.log(`| ${r.prompt} | ${r.lang} | ${r.intent} | ${r.config} | ${r.in} | ${r.out} | ${r.ms} |`)

  const byCfg = new Map<string, { n: number; inSum: number; outSum: number }>()
  for (const r of rows) {
    const agg = byCfg.get(r.config) ?? { n: 0, inSum: 0, outSum: 0 }
    agg.n++
    agg.inSum += r.in
    agg.outSum += r.out
    byCfg.set(r.config, agg)
  }
  const base = byCfg.get("baseline")!
  console.log("\n## Aggregates\n")
  console.log("| config | calls | avg in | avg out | total out | Δ vs baseline | %Δ |")
  console.log("|--------|-------|--------|---------|-----------|---------------|-----|")
  for (const [name, agg] of byCfg) {
    const avgIn = (agg.inSum / agg.n).toFixed(0)
    const avgOut = (agg.outSum / agg.n).toFixed(0)
    const diff = agg.outSum - base.outSum
    const pct = ((diff / base.outSum) * 100).toFixed(1)
    console.log(`| ${name} | ${agg.n} | ${avgIn} | ${avgOut} | ${agg.outSum} | ${diff} | ${pct}% |`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
