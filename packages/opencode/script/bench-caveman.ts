#!/usr/bin/env bun
import { readFile } from "fs/promises"
import { homedir } from "os"
import path from "path"
import { Caveman } from "../src/session/caveman"

const PROMPTS = [
  { lang: "en", intent: "research", text: "Explain how OAuth 2.0 authorization code flow works and when to use it." },
  { lang: "pt", intent: "research", text: "Explique como funciona o Virtual DOM do React e por que ele é eficiente." },
  { lang: "en", intent: "investigation", text: "Look into why my React component re-renders on every keystroke despite memoization." },
  { lang: "pt", intent: "investigation", text: "Investigar porque o bundle está com 800kb mesmo após tree-shaking agressivo." },
  { lang: "en", intent: "evaluation", text: "What do you think of using Bun over Node.js in a production web API?" },
  { lang: "pt", intent: "evaluation", text: "O que você acha de usar Zustand em vez de Redux Toolkit para um app médio?" },
  { lang: "en", intent: "implementation", text: "Implement a debounce function in TypeScript with proper cancel/flush semantics and show unit tests." },
  { lang: "pt", intent: "implementation", text: "Implementar um hook useDebouncedState em React+TypeScript com cleanup correto e demonstrar o uso." },
  { lang: "en", intent: "fix", text: "Fix this bug: 'Cannot read property map of undefined' in UserList when users fetch fails. Show the patch." },
  { lang: "pt", intent: "fix", text: "Corrigir o erro 'Cannot read property map of undefined' no UserList quando o fetch falha. Mostre o patch." },
  { lang: "en", intent: "documentation", text: "Write a README.md for a CLI tool called 'grogu' that fetches weather from OpenWeatherMap." },
  { lang: "pt", intent: "documentation", text: "Escrever a documentação completa do módulo de pagamentos incluindo exemplos de uso e troubleshooting." },
]

const MODEL = "claude-haiku-4-5-20251001"
const MAX_TOKENS = 600

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
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userMsg }],
  })

  const mBase = process.env.ANTHROPIC_BASE_URL
  const mKey = process.env.ANTHROPIC_API_KEY

  const doFetch = async (endpoint: string, headers: Record<string, string>, b: string) => {
    const res = await fetch(endpoint, { method: "POST", headers, body: b })
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: Usage; error?: { message: string } }
    if (!res.ok) return { ok: false, text: "", ms: Date.now() - started, error: json.error?.message ?? `HTTP ${res.status}` }
    const text = (json.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("")
    return { ok: true, text, usage: json.usage, ms: Date.now() - started }
  }

  if (mBase && mKey) {
    return doFetch(
      `${mBase.replace(/\/$/, "")}/v1/messages`,
      { "Content-Type": "application/json", "x-api-key": mKey, "anthropic-version": "2023-06-01" },
      body,
    )
  }

  const c = await creds()
  if (!c) return { ok: false, text: "", ms: Date.now() - started, error: "no credentials" }

  return doFetch(
    "https://api.anthropic.com/v1/messages",
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.107 (external, cli)",
    },
    JSON.stringify({
      ...JSON.parse(body),
      system: `You are Claude Code, Anthropic's official CLI for Claude.\n\n${system}`,
    }),
  )
}

const BASE_SYSTEM = "You are a helpful senior software engineer. Answer the user's question."

const configs = [
  { name: "baseline (no caveman)", system: BASE_SYSTEM },
  { name: "caveman:lite", system: `${BASE_SYSTEM}\n\n${Caveman.hint("lite")}` },
  { name: "caveman:full", system: `${BASE_SYSTEM}\n\n${Caveman.hint("full")}` },
  { name: "caveman:ultra", system: `${BASE_SYSTEM}\n\n${Caveman.hint("ultra")}` },
]

type Row = {
  config: string
  prompt: number
  lang: string
  intent: string
  in_tok: number
  out_tok: number
  ms: number
  snippet: string
}

async function main() {
  console.log(`# Caveman token benchmark — model=${MODEL}, max_tokens=${MAX_TOKENS}`)
  console.log(`prompts: ${PROMPTS.length}, configs: ${configs.length}, total calls: ${PROMPTS.length * configs.length}\n`)

  const rows: Row[] = []

  for (let i = 0; i < PROMPTS.length; i++) {
    const p = PROMPTS[i]
    for (const cfg of configs) {
      process.stderr.write(`→ [${i + 1}/${PROMPTS.length}] ${cfg.name.padEnd(28)} ... `)
      const r = await call(cfg.system, p.text)
      if (!r.ok || !r.usage) {
        process.stderr.write(`FAIL: ${r.error ?? "no usage"}\n`)
        continue
      }
      rows.push({
        config: cfg.name,
        prompt: i + 1,
        lang: p.lang,
        intent: p.intent,
        in_tok: r.usage.input_tokens,
        out_tok: r.usage.output_tokens,
        ms: r.ms,
        snippet: r.text.slice(0, 120).replace(/\n/g, " "),
      })
      process.stderr.write(`in=${r.usage.input_tokens} out=${r.usage.output_tokens} ms=${r.ms}\n`)
      await new Promise((res) => setTimeout(res, 200))
    }
  }

  console.log("\n## Per-call results\n")
  console.log("| # | lang | intent | config | in | out | ms |")
  console.log("|---|------|--------|--------|----|----|-----|")
  for (const r of rows) {
    console.log(`| ${r.prompt} | ${r.lang} | ${r.intent} | ${r.config} | ${r.in_tok} | ${r.out_tok} | ${r.ms} |`)
  }

  console.log("\n## Aggregates by config\n")
  console.log("| config | calls | avg in | avg out | total out | out Δ vs baseline | out %Δ |")
  console.log("|--------|-------|--------|---------|-----------|-------------------|--------|")
  const byCfg = new Map<string, { n: number; inSum: number; outSum: number }>()
  for (const r of rows) {
    const agg = byCfg.get(r.config) ?? { n: 0, inSum: 0, outSum: 0 }
    agg.n++
    agg.inSum += r.in_tok
    agg.outSum += r.out_tok
    byCfg.set(r.config, agg)
  }
  const baseline = byCfg.get("baseline (no caveman)")
  for (const [name, agg] of byCfg) {
    const avgIn = (agg.inSum / agg.n).toFixed(0)
    const avgOut = (agg.outSum / agg.n).toFixed(0)
    let delta = "-"
    let pct = "-"
    if (baseline && name !== baseline.n.toString()) {
      const base = baseline.outSum
      const diff = agg.outSum - base
      delta = `${diff > 0 ? "+" : ""}${diff}`
      pct = `${((diff / base) * 100).toFixed(1)}%`
    }
    console.log(`| ${name} | ${agg.n} | ${avgIn} | ${avgOut} | ${agg.outSum} | ${delta} | ${pct} |`)
  }

  console.log("\n## Sample outputs (first 120 chars)\n")
  for (const r of rows.slice(0, 8)) {
    console.log(`**[${r.config}]** prompt #${r.prompt} (${r.lang}/${r.intent})`)
    console.log(`> ${r.snippet}\n`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
