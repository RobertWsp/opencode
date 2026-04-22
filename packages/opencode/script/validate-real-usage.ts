#!/usr/bin/env bun
import { Intent } from "../src/agent/intent"
import { Caveman } from "../src/session/caveman"

const realUserMessages: { text: string; expected: Intent.Type; cavemanExpected: boolean; note: string }[] = [
  { text: "faça uma análise/revisão detalhada corretamente do sistema caveman porfavor", expected: "investigation", cavemanExpected: true, note: "user's most common phrasing — detailed work, not verbose output" },
  { text: "faça um estudo detalhado corretamente porfavor", expected: "investigation", cavemanExpected: true, note: "study = investigation" },
  { text: "estude em detalhes o sistema, em relação aas sessões reais", expected: "investigation", cavemanExpected: true, note: "estude = study/investigate" },
  { text: "faça uma análise/revisão detalhada sobre isso corretamente porfavor", expected: "investigation", cavemanExpected: true, note: "review detailed" },
  { text: "refactor nossa arquitetura de autenticacao", expected: "implementation", cavemanExpected: true, note: "refactor = implementation" },
  { text: "Implementar função debounce em TypeScript", expected: "implementation", cavemanExpected: true, note: "plain implementation pt" },
  { text: "Fix the null pointer bug in UserList", expected: "fix", cavemanExpected: true, note: "plain fix en" },
  { text: "Corrigir o erro 'Cannot read property map of undefined'", expected: "fix", cavemanExpected: true, note: "corrigir = fix pt" },
  { text: "Escrever a documentação do módulo pagamentos", expected: "documentation", cavemanExpected: false, note: "doc artifact — NO caveman" },
  { text: "Explique como funciona o Virtual DOM do React", expected: "research", cavemanExpected: true, note: "research explain" },
  { text: "Eu preciso que faça a correção do sistema corretamente porfavor", expected: "fix", cavemanExpected: true, note: "correction = fix" },
  { text: "Faça todas as implementações no sistema corretamente", expected: "implementation", cavemanExpected: true, note: "implement all" },
  { text: "Eu preciso que você teste e valide o sistema", expected: "investigation", cavemanExpected: true, note: "validate = investigate" },
  { text: "pesquise mais sobre o caveman corretamente porfavor", expected: "investigation", cavemanExpected: true, note: "pesquisar = research/investigate" },
  { text: "Análise cada sessão corretametne do README.md", expected: "investigation", cavemanExpected: true, note: "analyze" },
  { text: "continuar", expected: "conversation", cavemanExpected: false, note: "continuation — trivial, no caveman needed" },
  { text: "Certo, então agora tudo que eu for fazer já está utilizando o caveman correto?", expected: "research", cavemanExpected: true, note: "question about system" },
  { text: "O que você acha de usar Zustand em vez de Redux?", expected: "evaluation", cavemanExpected: true, note: "opinion request" },
  { text: "identificar os padrões e validar o sistema", expected: "investigation", cavemanExpected: true, note: "identify patterns + validate" },
  { text: "Certo, mas se deu problema, você precisa análisar o sistema e corrigir", expected: "fix", cavemanExpected: true, note: "analyze + fix" },
]

const cfg: Awaited<ReturnType<typeof Caveman.settings>> = {
  enabled: true,
  level: "full",
  intents: ["research", "investigation", "evaluation", "implementation", "fix"],
  minMessageLength: 0,
  classifier: "regex",
  classifierTimeoutMs: 3000,
  agents: {},
}

console.log("# Validação contra mensagens reais do usuário\n")
console.log("| # | msg preview | expected | got | active? | expected active | verdict | note |")
console.log("|---|-------------|----------|-----|---------|-----------------|---------|------|")

let ok = 0
let fail = 0
for (let i = 0; i < realUserMessages.length; i++) {
  const row = realUserMessages[i]
  const r = Intent.classifySync(row.text)
  const disabledMsg = Caveman.disabledByMessage(row.text)
  const active = !disabledMsg && Caveman.shouldActivate(r.type, row.text, cfg)
  const intentOK = r.type === row.expected
  const activeOK = active === row.cavemanExpected
  const verdict = intentOK && activeOK ? "OK" : (!intentOK && !activeOK ? "FAIL-both" : !intentOK ? "FAIL-intent" : "FAIL-active")
  if (verdict === "OK") ok++
  else fail++
  const preview = row.text.slice(0, 50).replace(/\|/g, " ")
  console.log(`| ${i + 1} | ${preview} | ${row.expected} | ${r.type} | ${active} | ${row.cavemanExpected} | ${verdict} | ${row.note} |`)
}

console.log(`\n**Summary**: ${ok} OK, ${fail} FAIL (total ${realUserMessages.length})\n`)
