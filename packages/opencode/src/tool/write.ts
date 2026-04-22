import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectory } from "./external-directory"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("The content to write to the file"),
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filepath)

    const exists = await Filesystem.exists(filepath)
    const contentOld = exists ? await Filesystem.readText(filepath) : ""
    if (exists) await FileTime.assert(ctx.sessionID, filepath)

    const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: {
        filepath,
        diff,
      },
    })

    await Filesystem.write(filepath, params.content)
    await Bus.publish(File.Event.Edited, {
      file: filepath,
    })
    await Bus.publish(FileWatcher.Event.Updated, {
      file: filepath,
      event: exists ? "change" : "add",
    })
    FileTime.read(ctx.sessionID, filepath)

    let output = "Wrote file successfully."
    await LSP.touchFile(filepath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilepath = Filesystem.normalizePath(filepath)
    let projectDiagnosticsCount = 0
    let fileErrorCount = 0
    let fileWarningCount = 0
    const fileErrors: Array<{ line: number; character: number; message: string; source: string; code?: string }> = []
    const fileWarnings: Array<{ line: number; character: number; message: string; source: string; code?: string }> = []
    for (const [file, issues] of Object.entries(diagnostics)) {
      const errors = issues.filter((item) => item.severity === 1)
      const warnings = issues.filter((item) => item.severity === 2)
      if (file === normalizedFilepath) {
        fileErrorCount = errors.length
        fileWarningCount = warnings.length
        for (const d of errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)) {
          fileErrors.push({
            line: d.range?.start?.line ?? 0,
            character: d.range?.start?.character ?? 0,
            message: d.message ?? "",
            source: d.source ?? "lsp",
            code: typeof d.code === "string" || typeof d.code === "number" ? String(d.code) : undefined,
          })
        }
        for (const d of warnings.slice(0, MAX_DIAGNOSTICS_PER_FILE)) {
          fileWarnings.push({
            line: d.range?.start?.line ?? 0,
            character: d.range?.start?.character ?? 0,
            message: d.message ?? "",
            source: d.source ?? "lsp",
            code: typeof d.code === "string" || typeof d.code === "number" ? String(d.code) : undefined,
          })
        }
      }
      if (errors.length === 0) continue
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      if (file === normalizedFilepath) {
        output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filepath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
        continue
      }
      if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      projectDiagnosticsCount++
      output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    const diagnosticsSummary = {
      file: filepath,
      errorCount: fileErrorCount,
      warningCount: fileWarningCount,
      errors: fileErrors,
      warnings: fileWarnings,
    }

    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics,
        diagnosticsSummary,
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
