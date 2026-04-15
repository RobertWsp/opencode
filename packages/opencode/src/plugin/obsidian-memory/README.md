# obsidian-memory

Git-first, branch-aware memory injection for opencode, backed by an Obsidian
vault on the local filesystem.

This is the **MVP** scope (phase F0-F4 of the plan at
`~/.claude/plans/golden-floating-flurry.md`). Future phases will add
LLM-powered capture (Haiku gate / Sonnet consolidation), file-ref
verification, user-level memories, and TUI integration.

## What it does today

- **Detects scope** from the current worktree: `(repo, branch)` via
  `git config --get remote.origin.url`, `git rev-parse --show-toplevel`,
  and `git rev-parse --abbrev-ref HEAD`. Repo slug is `<basename>-<6char-hash>`
  so clones on multiple machines resolve to the same vault directory.
- **Injects memory** into the anthropic system prompt via the
  `experimental.chat.system.transform` hook, as a contiguous `<memory-block>`
  that is idempotent (byte-identical for the same vault state) so Anthropic
  prompt caching hits across turns.
- **Slash commands** via the `command.execute.before` hook:
  - `/memory list` — list shared MEMORY.md + recent notes in scope
  - `/memory save <title>` — capture last user/assistant exchange as a note
  - `/memory show <relPath>` — read any file inside the vault root
    (rejects `../` path traversal)

## Vault layout

```
<vaultPath>/opencode/
  repos/
    <basename>-<shortHash>/
      MEMORY.md                            # shared across branches
      branches/
        <branch-slug>/
          MEMORY.md                        # branch-level shared
          notes/
            2026-04-15T12-30-05-*.md       # captured notes
```

## Config

```json
{
  "memory": {
    "enabled": true,
    "vaultPath": "~/Obsidian/dev-memory",
    "maxBytes": 4096,
    "maxNotes": 20
  }
}
```

When `enabled: false` (default), the plugin is a no-op: no hook runs, no
command registers.

## Caveats

1. **Anthropic-only injection**. The `experimental.chat.system.transform`
   hook bails when `providerID !== "anthropic"`. Other providers would get
   no cache-hit benefit and the hook pattern was tuned for anthropic's
   system-prompt rejoin in `session/llm.ts:151-155`.

2. **Sanitizer evasion**. `plugin/anthropic.ts:197-198` rewrites the string
   `opencode` (case-insensitive) to `Claude` before sending. The memory
   block uses only `shortHash` in the wrapper tag (not `basename`), so repo
   slugs containing "opencode" are not corrupted in the final prompt.
   The word `opencode` still appears as a filesystem path segment (`opencode/repos/...`)
   but that never enters the prompt. If a user's own `MEMORY.md` contains
   the word `opencode`, it **will** be rewritten — document as known limitation.

3. **Slash commands still hit the LLM**. Mutating `output.parts` in
   `command.execute.before` replaces the template but opencode still calls
   the model with the resulting user message. A future refinement is to
   use the `router-notifications` pattern for truly local operations.

4. **File reference verification is not implemented**. Notes may contain
   `@path:line` markers but there is no check that the reference still
   resolves against HEAD. Planned for a future phase.

5. **Branches with slashes collapse to dashes**. `feature/A` and
   `feature-A` both sanitize to `feature-A`. Hash suffix to disambiguate
   is a future enhancement.

## Tests

```bash
cd packages/opencode
bun test test/plugin/obsidian-memory/
# Expected: 72+ tests passing
```

Unit tests cover: frontmatter parse/serialize round-trip, scope detection
with various git configurations (remote, no-remote, detached HEAD, long/
sanitized branches), vault fingerprint stability, loadAll ordering, writeNote
path construction, injector byte-identity and truncation, command handlers
(save/list/show) with path-traversal guard. Integration tests exercise the
full hook flow end-to-end with fake inputs.
