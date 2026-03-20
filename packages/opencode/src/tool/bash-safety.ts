export namespace BashSafety {
  export type Level = "blocked" | "danger" | "safe"

  export interface Result {
    level: Level
    reason?: string
    alternative?: string
  }

  interface Pattern {
    test: (tokens: string[], raw: string) => boolean
    reason: string
    alternative: string
  }

  const SHELL_WRAPPERS = new Set(["eval", "sh", "bash", "zsh", "dash", "env", "command", "exec", "nohup", "sudo"])
  const PIPE_SHELLS = new Set(["sh", "bash", "zsh", "dash"])

  const BLOCKED: Pattern[] = [
    {
      test: (tokens) => tokens[0] === "rm" && hasFlags(tokens, ["rf", "fr"]) && hasRootPath(tokens),
      reason: "rm -rf on root, home, or wildcard path destroys the filesystem",
      alternative: "Remove specific files: rm <file1> <file2>, or use git checkout to restore tracked files.",
    },
    {
      test: (tokens) =>
        tokens[0] === "rm" && hasFlags(tokens, ["rf", "fr"]) && tokens.some((t) => t === "/" || t === "/*"),
      reason: "rm -rf / destroys the entire filesystem",
      alternative: "Remove specific files or directories instead.",
    },
    {
      test: (tokens) => tokens[0] === "git" && tokens[1] === "reset" && hasFlag(tokens, "hard"),
      reason: "git reset --hard permanently destroys uncommitted changes",
      alternative:
        "Use `git stash` to save changes, `git checkout -- <file>` for specific files, or `git revert <commit>` to undo a commit safely.",
    },
    {
      test: (tokens) =>
        tokens[0] === "git" &&
        tokens[1] === "push" &&
        hasFlag(tokens, "force") &&
        !hasFlag(tokens, "force-with-lease") &&
        targetsBranch(tokens, ["main", "master"]),
      reason: "git push --force to main/master rewrites shared history and can cause data loss for the entire team",
      alternative:
        "Use `git push --force-with-lease` on feature branches only. For main/master, use `git revert` instead.",
    },
    {
      test: (tokens) => tokens[0] === "git" && tokens[1] === "clean" && hasFlags(tokens, ["fdx"]),
      reason: "git clean -fdx removes all untracked files AND ignored files (build artifacts, configs, etc.)",
      alternative:
        "Use `git clean -n` (dry-run) first to preview, then `git clean -f <specific-path>` for targeted cleanup.",
    },
    {
      test: (_tokens, raw) => /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/.test(raw),
      reason: "Fork bomb — crashes the system by spawning infinite processes",
      alternative: "This command has no legitimate use.",
    },
    {
      test: (tokens) => tokens[0] === "dd" && tokens.some((t) => /^of=\/dev\/[a-z]/.test(t)),
      reason: "dd writing to a device can destroy disk data",
      alternative: "Use dd with regular files only.",
    },
    {
      test: (tokens, raw) => tokens[0] === "mkfs" || /^mkfs\.\w+/.test(raw),
      reason: "mkfs formats a disk partition, destroying all data on it",
      alternative: "This command should not be run from an AI agent.",
    },
    {
      test: (_tokens, raw) => />\s*\/dev\/[hs]d[a-z]/.test(raw),
      reason: "Redirecting output to a block device destroys disk data",
      alternative: "Redirect to a regular file instead.",
    },
    {
      test: (tokens) => tokens[0] === "chmod" && tokens.includes("-R") && tokens.includes("777") && hasRootPath(tokens),
      reason: "chmod -R 777 on root or home removes all permission security",
      alternative: "Use specific permissions (e.g., chmod 755) on specific files.",
    },
    {
      test: (_tokens, raw) => />\s*\/dev\/null\s*2>&1\s*<\s*\/dev\/null/.test(raw) && /rm\s/.test(raw),
      reason: "Silenced destructive command — hiding rm output is suspicious",
      alternative: "Run destructive commands with visible output.",
    },
  ]

  const DANGER: Pattern[] = [
    {
      test: (tokens) => tokens[0] === "rm" && hasFlags(tokens, ["rf", "fr", "r"]),
      reason: "Recursive delete can remove entire directory trees",
      alternative: "Consider removing specific files, or use git checkout to restore.",
    },
    {
      test: (tokens) =>
        tokens[0] === "git" && tokens[1] === "push" && (hasFlag(tokens, "force") || tokens.includes("-f")),
      reason: "Force push rewrites remote history",
      alternative: "Use `git push --force-with-lease` for safer force pushes on feature branches.",
    },
    {
      test: (tokens) => tokens[0] === "git" && tokens[1] === "push" && hasFlag(tokens, "force-with-lease"),
      reason: "Force push (even with lease) rewrites remote history",
      alternative: "Ensure you are on a feature branch, not main/master.",
    },
    {
      test: (tokens) =>
        tokens[0] === "git" && tokens[1] === "clean" && !tokens.includes("-n") && !tokens.includes("--dry-run"),
      reason: "git clean removes untracked files permanently",
      alternative: "Use `git clean -n` (dry-run) first to preview what will be removed.",
    },
    {
      test: (tokens) => tokens[0] === "git" && tokens[1] === "checkout" && tokens.includes("--"),
      reason: "git checkout -- discards uncommitted changes to files",
      alternative: "Use `git stash` first to save changes before discarding.",
    },
    {
      test: (tokens) =>
        tokens[0] === "git" && tokens[1] === "branch" && (tokens.includes("-D") || tokens.includes("-d")),
      reason: "Deleting a git branch is irreversible if not merged",
      alternative: "Verify the branch is merged first with `git branch --merged`.",
    },
    {
      test: (tokens) => tokens[0] === "git" && tokens[1] === "rebase",
      reason: "Rebase rewrites commit history",
      alternative: "Ensure you are on a feature branch. Consider `git merge` for shared branches.",
    },
    {
      test: (tokens) => tokens[0] === "chmod" || tokens[0] === "chown",
      reason: "Changing file permissions/ownership can break system access",
      alternative: "Use specific permissions on specific files.",
    },
    {
      test: (tokens) => tokens[0] === "git" && tokens[1] === "config" && hasFlag(tokens, "global"),
      reason: "Modifying global git config affects all repositories",
      alternative: "Use local config (without --global) for project-specific settings.",
    },
    {
      test: (tokens, raw) => !isOutputCmd(tokens[0]) && /DROP\s+(TABLE|DATABASE|INDEX|SCHEMA)/i.test(raw),
      reason: "DROP permanently removes database objects",
      alternative: "Create a backup first, or use a migration tool.",
    },
    {
      test: (tokens, raw) =>
        !isOutputCmd(tokens[0]) && /DELETE\s+FROM\s+\S+\s*;?\s*$/i.test(raw) && !/WHERE/i.test(raw),
      reason: "DELETE without WHERE removes all rows from the table",
      alternative: "Add a WHERE clause, or use TRUNCATE with explicit confirmation.",
    },
    {
      test: (tokens, raw) => !isOutputCmd(tokens[0]) && /TRUNCATE\s+(TABLE\s+)?\S+/i.test(raw),
      reason: "TRUNCATE removes all data from a table",
      alternative: "Create a backup first.",
    },
    {
      test: (tokens) =>
        (tokens[0] === "npm" || tokens[0] === "pnpm" || tokens[0] === "yarn" || tokens[0] === "cargo") &&
        tokens[1] === "publish",
      reason: "Publishing a package is irreversible on most registries",
      alternative: "Use `--dry-run` first to verify the publish contents.",
    },
  ]

  export function classify(tokens: string[], raw: string): Result {
    const normalized = normalize(tokens)
    for (const pattern of BLOCKED) {
      if (pattern.test(normalized, raw))
        return { level: "blocked", reason: pattern.reason, alternative: pattern.alternative }
    }
    for (const pattern of DANGER) {
      if (pattern.test(normalized, raw))
        return { level: "danger", reason: pattern.reason, alternative: pattern.alternative }
    }

    const indirection = detectIndirection(tokens, raw)
    if (indirection) return indirection

    return { level: "safe" }
  }

  export function tokenize(text: string): string[] {
    return text
      .split(/\s+/)
      .map((t) => t.replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  }

  function normalize(tokens: string[]): string[] {
    if (tokens.length === 0) return tokens
    const skip = new Set(["env", "command", "exec", "nohup", "sudo"])
    let start = 0
    while (start < tokens.length && skip.has(tokens[start])) start++
    const result = start > 0 ? tokens.slice(start) : [...tokens]
    if (result.length > 0) result[0] = basename(result[0])
    return result
  }

  function basename(cmd: string): string {
    const slash = cmd.lastIndexOf("/")
    return slash >= 0 ? cmd.slice(slash + 1) : cmd
  }

  function detectIndirection(tokens: string[], raw: string): Result | undefined {
    if (tokens.length === 0) return undefined

    if (tokens[0] === "eval") {
      const inner = tokens.slice(1).join(" ")
      const sub = classify(tokenize(inner), inner)
      if (sub.level !== "safe")
        return { level: sub.level, reason: `eval wrapping: ${sub.reason}`, alternative: sub.alternative }
    }

    if (SHELL_WRAPPERS.has(tokens[0]) && tokens.includes("-c")) {
      const idx = tokens.indexOf("-c")
      const inner = tokens.slice(idx + 1).join(" ")
      if (inner) {
        const sub = classify(tokenize(inner), inner)
        if (sub.level !== "safe")
          return { level: sub.level, reason: `${tokens[0]} -c wrapping: ${sub.reason}`, alternative: sub.alternative }
      }
    }

    if (/\|\s*(bash|sh|zsh|dash)\b/.test(raw))
      return {
        level: "danger",
        reason: "Piping output to a shell executes arbitrary commands",
        alternative: "Write the command directly instead of piping to a shell.",
      }

    if (/\bxargs\s+/.test(raw)) {
      const match = raw.match(/xargs\s+(.+)/)
      if (match) {
        const sub = classify(tokenize(match[1]), match[1])
        if (sub.level !== "safe")
          return { level: sub.level, reason: `xargs wrapping: ${sub.reason}`, alternative: sub.alternative }
      }
    }

    if (/\bbase64\b.*\|\s*(bash|sh|zsh|dash)\b/.test(raw))
      return {
        level: "danger",
        reason: "Encoded payload piped to shell — cannot verify safety",
        alternative: "Decode and review the command first, then run it directly.",
      }

    return undefined
  }

  const OUTPUT_CMDS = new Set(["echo", "printf", "cat", "head", "tail", "less", "more", "log", "warn", "info"])

  function isOutputCmd(cmd: string): boolean {
    return OUTPUT_CMDS.has(cmd)
  }

  function hasFlag(tokens: string[], name: string): boolean {
    return tokens.some((t) => t === `--${name}` || t.startsWith(`--${name}=`))
  }

  function hasFlags(tokens: string[], patterns: string[]): boolean {
    const flags = tokens.filter((t) => t.startsWith("-")).map((t) => t.replace(/^-+/, "").split("=")[0])
    return patterns.some((p) => flags.some((f) => containsAll(f, p)))
  }

  function containsAll(flag: string, chars: string): boolean {
    return [...chars].every((c) => flag.includes(c))
  }

  function hasRootPath(tokens: string[]): boolean {
    const dangerous = ["/", "/*", "~", "~/", "$HOME", "$HOME/"]
    return tokens.some((t) => dangerous.includes(t) || t === "." || t === "..")
  }

  function targetsBranch(tokens: string[], branches: string[]): boolean {
    return tokens.some((t) => branches.includes(t))
  }
}
