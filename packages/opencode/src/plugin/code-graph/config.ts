import { z } from "zod"

export const CodeGraphConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default(".opencode/code-graph.db"),
  autoBuild: z.boolean().default(false),
  languages: z
    .array(z.string())
    .default(["ts", "tsx", "js", "jsx", "py", "go", "rs"]),
  watch: z.boolean().default(true),
  maxFileBytes: z.number().default(524288),
  ignore: z
    .array(z.string())
    .default([
      "node_modules/**",
      "dist/**",
      "build/**",
      ".git/**",
      ".venv/**",
      "__pycache__/**",
      "target/**",
      "coverage/**",
    ]),
})

export type CodeGraphConfig = z.infer<typeof CodeGraphConfigSchema>

export function parseCodeGraphConfig(raw: unknown): CodeGraphConfig {
  return CodeGraphConfigSchema.parse(raw ?? {})
}
