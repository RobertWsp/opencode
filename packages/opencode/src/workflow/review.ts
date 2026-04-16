export namespace Review {
  export const SPEC = `## Stage 1: Spec Compliance (run FIRST)

For each requirement in the plan:
- [ ] Is it implemented? (yes/no with file:line reference)
- [ ] Does it match locked decisions? (reference D-XX)
- [ ] Are deferred items absent from the implementation?

DO NOT evaluate code quality yet. Only spec compliance.
Fail this stage = stop. Do not proceed to Stage 2.`

  export const QUALITY = `## Stage 2: Code Quality (run AFTER Stage 1 passes)

- [ ] Tests exist and pass for every new function
- [ ] No type errors (tsc/tsgo --noEmit clean)
- [ ] No lint warnings
- [ ] Error handling complete (no empty catch blocks)
- [ ] Edge cases covered
- [ ] No security issues (OWASP top 10 checked)
- [ ] Performance acceptable (no N+1, no unbounded loops)`

  export function prompt(stage: 1 | 2): string {
    if (stage === 1) return SPEC
    return QUALITY
  }

  export function full(): string {
    return [SPEC, "", QUALITY].join("\n")
  }
}
