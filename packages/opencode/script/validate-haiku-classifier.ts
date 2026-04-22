#!/usr/bin/env bun
import { Intent } from "../src/agent/intent"
import { Caveman } from "../src/session/caveman"

const cases: { text: string; expected: Intent.Type; cavemanExpected: boolean; note: string }[] = [
  { text: "faça uma análise/revisão detalhada corretamente do sistema caveman porfavor", expected: "investigation", cavemanExpected: true, note: "analysis request pt" },
  { text: "faça um estudo detalhado corretamente porfavor", expected: "investigation", cavemanExpected: true, note: "study request pt" },
  { text: "estude em detalhes o sistema, em relação aas sessões reais", expected: "investigation", cavemanExpected: true, note: "study pt" },
  { text: "faça uma análise/revisão detalhada sobre isso corretamente porfavor", expected: "investigation", cavemanExpected: true, note: "review pt" },
  { text: "refactor nossa arquitetura de autenticacao", expected: "implementation", cavemanExpected: true, note: "refactor en" },
  { text: "Implementar função debounce em TypeScript", expected: "implementation", cavemanExpected: true, note: "implement pt" },
  { text: "Fix the null pointer bug in UserList", expected: "fix", cavemanExpected: true, note: "fix en" },
  { text: "Corrigir o erro 'Cannot read property map of undefined'", expected: "fix", cavemanExpected: true, note: "corrigir pt" },
  { text: "Escrever a documentação do módulo pagamentos", expected: "documentation", cavemanExpected: false, note: "doc artifact — NO caveman" },
  { text: "Explique como funciona o Virtual DOM do React", expected: "research", cavemanExpected: true, note: "explain pt" },
  { text: "Eu preciso que faça a correção do sistema corretamente porfavor", expected: "fix", cavemanExpected: true, note: "correção pt" },
  { text: "Faça todas as implementações no sistema corretamente", expected: "implementation", cavemanExpected: true, note: "implement all pt" },
  { text: "Eu preciso que você teste e valide o sistema", expected: "investigation", cavemanExpected: true, note: "validate pt" },
  { text: "pesquise mais sobre o caveman corretamente porfavor", expected: "investigation", cavemanExpected: true, note: "pesquisar pt" },
  { text: "Análise cada sessão corretametne do README.md", expected: "investigation", cavemanExpected: true, note: "analyze pt (typo)" },
  { text: "continuar", expected: "conversation", cavemanExpected: false, note: "continuation" },
  { text: "O que você acha de usar Zustand em vez de Redux?", expected: "evaluation", cavemanExpected: true, note: "opinion pt" },
  { text: "identificar os padrões e validar o sistema", expected: "investigation", cavemanExpected: true, note: "identify+validate pt" },
  { text: "write a README for grogu CLI", expected: "documentation", cavemanExpected: false, note: "doc en" },
  { text: "add a debounce util", expected: "implementation", cavemanExpected: true, note: "add en" },
  { text: "o que é TypeScript satisfies operator", expected: "research", cavemanExpected: true, note: "what is pt" },
  { text: "investiga porque o build tá quebrado", expected: "investigation", cavemanExpected: true, note: "investigate pt colloquial" },
  { text: "me explique detalhadamente como OAuth funciona", expected: "research", cavemanExpected: false, note: "verbose request — DISABLE" },
  { text: "hi", expected: "conversation", cavemanExpected: false, note: "greeting" },
  { text: "obrigado", expected: "conversation", cavemanExpected: false, note: "thanks pt" },
  { text: "compare React Query vs SWR para cache de API", expected: "evaluation", cavemanExpected: true, note: "compare pt" },
  { text: "revise o PR #42 e me dá feedback", expected: "investigation", cavemanExpected: true, note: "PR review pt" },
  { text: "dá uma olhada no auth middleware", expected: "investigation", cavemanExpected: true, note: "casual look pt" },
  { text: "o login tá quebrando quando token expira", expected: "fix", cavemanExpected: true, note: "bug report pt casual" },
  { text: "atualizar o CHANGELOG com as mudanças da v2", expected: "documentation", cavemanExpected: false, note: "changelog update — doc" },
]

const baseCfg = {
  enabled: true,
  level: "full" as const,
  intents: ["research", "investigation", "evaluation", "implementation", "fix"] as Intent.Type[],
  minMessageLength: 0,
  classifier: "haiku" as const,
  classifierTimeoutMs: 8000,
  agents: {},
}

async function run() {
  Intent._resetCache()
  console.log(`# Haiku classifier validation — ${cases.length} real-usage cases\n`)
  console.log("| # | msg preview | expected | got | source | conf | active | expected active | verdict |")
  console.log("|---|-------------|----------|-----|--------|------|--------|-----------------|---------|")

  let ok = 0
  let fail = 0
  let haikuUsed = 0
  let fellBack = 0
  const failures: { i: number; text: string; expected: string; got: string; source: string; verdict: string }[] = []

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    const r = await Intent.classify(c.text, { classifier: baseCfg.classifier, timeoutMs: baseCfg.classifierTimeoutMs })
    const disabled = Caveman.disabledByMessage(c.text)
    const active = !disabled && Caveman.shouldActivate(r.type, c.text, baseCfg)
    const intentOK = r.type === c.expected
    const activeOK = active === c.cavemanExpected
    const verdict = intentOK && activeOK ? "OK" : intentOK ? "fail-active" : activeOK ? "fail-intent" : "FAIL-both"
    if (verdict === "OK") ok++
    else {
      fail++
      failures.push({ i: i + 1, text: c.text, expected: c.expected, got: r.type, source: r.source, verdict })
    }
    if (r.source === "haiku") haikuUsed++
    if (r.source === "haiku-fallback") fellBack++
    const preview = c.text.slice(0, 55).replace(/\|/g, " ")
    console.log(`| ${i + 1} | ${preview} | ${c.expected} | ${r.type} | ${r.source} | ${r.confidence.toFixed(2)} | ${active} | ${c.cavemanExpected} | ${verdict} |`)
  }

  console.log(`\n**Summary**: ${ok}/${cases.length} OK (${((ok / cases.length) * 100).toFixed(0)}%), ${fail} FAIL`)
  console.log(`Haiku classifications: ${haikuUsed}/${cases.length}`)
  console.log(`Regex fallbacks: ${fellBack}/${cases.length}`)

  if (failures.length) {
    console.log(`\n## Failure detail\n`)
    for (const f of failures) {
      console.log(`- #${f.i} [${f.verdict}] expected=${f.expected} got=${f.got} (source=${f.source}) — "${f.text.slice(0, 80)}"`)
    }
  }
}

run().catch((e) => { console.error(e); process.exit(1) })
