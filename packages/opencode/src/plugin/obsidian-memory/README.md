# obsidian-memory

Git-first, branch-aware memory injection for opencode, backed by an Obsidian vault on the local filesystem.

## Features

- **Scope detection** -- resolves `(repo, branch)` from the active worktree via `git config --get remote.origin.url`, `git rev-parse --show-toplevel`, and `git rev-parse --abbrev-ref HEAD`. The repo slug is `<basename>-<6char-hash>` so clones on multiple machines map to the same vault directory.
- **Memory injection** -- appends a `<memory-block>` to the system prompt on every turn. Supports three injection styles: `full`, `index`, and `progressive`. Byte-identical blocks for the same vault state maximize Anthropic prompt-cache hits. All providers receive injection.
- **Smart retrieval** -- when `smartRetrieval` is enabled, notes are ranked by a composed scorer: recency, importance, relevance (BM25 token jaccard), and PageRank graph centrality. Vector similarity (cosine over stored embeddings) is included when an embedder is configured.
- **HyDE query expansion** -- when `hydeExpansion` is enabled and no embedder is configured, a Haiku call generates a hypothetical document from the user prompt before BM25 scoring. Bridges vocabulary gaps between the prompt and vault.
- **Auto-capture via Haiku gate** -- when `autoCapture` is enabled, every tool completion and user prompt is evaluated by a Haiku model that decides whether the event is worth persisting. Low-importance captures are written directly to `notes/`; high-importance captures above `suggestThreshold` go to `suggested/` for manual review.
- **Session summaries** -- when `sessionSummary` is enabled, a structured summary note is written at session idle containing the files touched and tool events from that session.
- **Sonnet consolidation and reflection** -- when `autoConsolidate` is enabled, a Sonnet model periodically reads recent notes and produces consolidated architecture summaries, contradiction flags, and reflection entries. Triggered on the session idle event, gated by minimum hours and session count since last run.
- **Contradiction detection** -- the consolidation pass flags notes that assert conflicting facts. Contradictions are surfaced in the reflection output but not automatically deleted.
- **Git event detection** -- bash tool calls that invoke `git` or `gh` subcommands are parsed and surfaced to the capture gate as high-signal events (commits, PRs, branch switches, merges).
- **File reference verification** -- before injection, every `@path:line` reference in candidate docs is checked against the current worktree HEAD. Stale refs are annotated in the injected block so the model knows which references may no longer resolve.
- **Proactive injection** -- notes of kind `gotcha` or `episode` whose `refs` frontmatter field matches a file touched in the current session are prepended to the injection, ahead of the ranked list.
- **Vault git operations** -- the vault directory is treated as a separate git repository. The auto-init path creates the vault structure and commits an initial state when the repo is new.
- **Auto-init for new repos** -- when `autoInit` is enabled and the scope directories do not exist, the plugin bootstraps the vault layout (repo MEMORY.md, branch MEMORY.md, notes and suggested directories) before the first injection.
- **Suggest mode** -- captures above `suggestThreshold` are held in `suggested/` instead of `notes/`. The user reviews them with `/memory suggested` and accepts or discards with `/memory approve` or `/memory reject`.
- **11 memory kinds** -- `fact`, `decision`, `gotcha`, `skill`, `episode`, `convention`, `session-summary`, `learned-pattern`, `architecture`, `tech-context`, `progress`. Kind is stored in frontmatter and drives retrieval boosting and proactive filtering.
- **Task-to-memory linking** -- the `links` frontmatter field holds wikilinks (`[[slug]]`) that connect notes to related memories. PageRank uses this graph to boost well-connected entries.

## Vault layout

```
<vaultPath>/
  _system/
    MEMORY.md                          # cross-repo user preferences + feedback index
  opencode/
    repos/
      <basename>-<shortHash>/
        MEMORY.md                      # repo-level shared (all branches)
        branches/
          <branch-slug>/
            MEMORY.md                  # branch-level shared
            notes/
              2026-04-15T12-30-05-*.md # captured notes (newest-first)
            suggested/
              2026-04-15T12-30-05-*.md # pending review captures
        vectors.db                     # SQLite vector store (when embedder configured)
```

Branch slugs are sanitized to `[a-z0-9-]`, truncated at 60 characters. Slashes in branch names become dashes.

## Config

All fields live under the `"memory"` key in `opencode.jsonc`.

```jsonc
{
  "memory": {
    // Required to activate the plugin. Default: false (no-op).
    "enabled": true,

    // Absolute path to the vault root. ~ is expanded. Default: undefined
    // (the plugin will not activate if omitted while enabled).
    "vaultPath": "~/Obsidian/dev-memory",

    // Maximum bytes the injected memory block may occupy in the system prompt.
    // Older or lower-ranked notes are dropped first. Default: 6000.
    "maxBytes": 6000,

    // Maximum number of notes to load from the branch notes directory before
    // ranking and truncation. Default: 20.
    "maxNotes": 20,

    // Injection style. Default: "full".
    //   "full"        -- inject system/repo/branch MEMORY.md + full note bodies.
    //   "index"       -- inject a compact index (title + description) only; the
    //                    model uses /memory show to read bodies on demand.
    //   "progressive" -- shared docs in full (stable cache-friendly prefix) +
    //                    notes as a compact index with per-entry show hints.
    "injectionStyle": "full",

    // Rank notes by composed scorer (recency + importance + BM25 + PageRank)
    // instead of mtime. Default: false.
    "smartRetrieval": false,

    // Run HyDE query expansion via captureModel before BM25 scoring.
    // Ignored when an embedder is configured (hybrid search covers semantics).
    // Costs ~$0.0001 per cache miss. Default: false.
    "hydeExpansion": false,

    // Enable automatic capture of tool events and user prompts. Default: false.
    "autoCapture": false,

    // Haiku model used by the capture gate and HyDE expansion.
    // Default: "claude-haiku-4-5-20251001".
    "captureModel": "claude-haiku-4-5-20251001",

    // Enable Sonnet-based consolidation and reflection on session idle.
    // Default: false.
    "autoConsolidate": false,

    // Sonnet model used by the consolidation and reflection pass.
    // Default: "claude-sonnet-4-5-20250929".
    "consolidateModel": "claude-sonnet-4-5-20250929",

    // Importance threshold for suggest mode. Captures at or above this value
    // go to suggested/ instead of notes/. 0 disables suggest mode (all
    // captures go directly to notes/). Default: 0.
    "suggestThreshold": 0,

    // Write a session-summary note at session idle. Default: false.
    "sessionSummary": false,

    // Bootstrap vault layout on first use when scope dirs are missing.
    // Default: false (undefined treated as false).
    "autoInit": false,

    // OpenAI-compatible embedding API key. When set, enables vector search.
    // Default: undefined (vector search disabled).
    "embedApiKey": "sk-...",

    // Embedding model name. Default: undefined.
    "embedModel": "text-embedding-3-small",

    // Embedding vector dimensions. Default: undefined (model default).
    "embedDimensions": 1536,

    // Run contradiction detection during the consolidation pass.
    // Default: false (undefined treated as false).
    "contradictionDetection": false
  }
}
```

## Slash commands

All commands are invoked as `/memory <verb> [args]`.

| Command | Description |
|---|---|
| `/memory list` | List repo MEMORY.md, branch MEMORY.md, and recent notes in the current scope. |
| `/memory save <title>` | Capture the last user/assistant exchange as a note with the given title. |
| `/memory show <relPath>` | Read any file inside the vault root. Rejects `../` path traversal. |
| `/memory stats` | Show note count, total size, and scope paths for the current worktree. |
| `/memory suggested` | List captures waiting in the `suggested/` staging area. |
| `/memory approve <slug>` | Move a suggested capture to `notes/`. |
| `/memory reject <slug>` | Delete a suggested capture without writing it to notes. |

Commands replace the user message parts before the LLM call. The model still receives the replaced text, so the session turn is consumed.

## Architecture

### Hooks registered

| Hook | Purpose |
|---|---|
| `config` | Parses `cfg.memory`, registers the `/memory` command, initializes the embedder and capture gate. |
| `command.execute.before` | Handles all `/memory` verbs and writes the result into `output.parts`. |
| `experimental.chat.system.transform` | Loads vault docs, runs smart retrieval and proactive filtering, verifies file refs, formats and appends the memory block to `hookOutput.system`. |
| `chat.message` | Records the user prompt for use by the next injection ranking pass. Also notifies the capture gate. |
| `tool.execute.after` | Enqueues tool outcomes to the capture gate. Extracts file paths from tool args for session-aware retrieval boosting. Detects git and gh CLI events. |
| `event` | On `session.idle`: flushes the capture gate, optionally writes a session summary, optionally triggers reflection. On `session.deleted` / `session.compacted`: clears per-session state. On `session.error`: enqueues the error to the capture gate. |

### Data flow per turn

```
user prompt
    |
    v
chat.message         --> lastPrompt[sessionID]
                     --> captureGate.noteUserPrompt()
    |
    v
system.transform
    |-- detectScope() --> Scope (repo slug, branch slug, paths)
    |-- autoInit?    --> shouldAutoInit() / runAutoInit()
    |-- fingerprint() --> cache check (30s TTL, fp-based)
    |   miss:
    |   |-- loadAll()          --> VaultDocs (system/repo/branch/notes)
    |   |-- embedder sync      --> upsert new notes to vector store
    |   |-- maybeRank()        --> HyDE? --> hybridRank / rankMemories / BM25+PR
    |   |-- prependProactive() --> gotcha/episode notes matching active files
    |   |-- buildRefHealthMap() --> verifyDocRefs() per doc
    |   |-- formatBlock()      --> <memory-block> string (style: full/index/progressive)
    |   |-- cache.set()
    |
    v
hookOutput.system.push(block)

tool.execute.after
    |-- extractFilePaths() --> sessionFiles[sessionID]
    |-- captureGate.enqueue(tool.after)
    |-- detectGitEvent / detectGhEvent --> captureGate.enqueue(git.*)

session.idle
    |-- captureGate.flush()
    |-- sessionSummary? --> buildSummary() --> writeNote()
    |-- autoConsolidate? --> runReflection() (Sonnet, gated by time + session count)
```

### Injection block format

The memory block is wrapped in `<memory repo="<shortHash>" branch="<branchSlug>">` tags. The `shortHash` is a 6-character sha256 prefix of the remote URL and worktree path, stable across machines. The tag is idempotent for the same vault fingerprint, allowing Anthropic prompt caching to hit across consecutive turns.

Stale file refs are annotated inline with `[ref stale]` so the model can avoid acting on paths that no longer exist at HEAD.

### Cache

The injection cache is keyed by `repoSlug::branchSlug::queryHash`. Entries expire after 30 seconds or when the vault fingerprint changes (mtime-based). A cache hit skips all disk I/O and ranking.

## Known limitations

1. **Branches with slashes collapse to dashes.** `feature/A` and `feature-A` both sanitize to `feature-A`. If two branches produce the same slug they share the same vault directory.

2. **Anthropic sanitizer rewrites "opencode".** `plugin/anthropic.ts` rewrites the string `opencode` (case-insensitive) to `Claude` before sending. If a user's MEMORY.md contains the word `opencode`, it will be rewritten in the injected prompt. Filesystem paths (`opencode/repos/...`) never enter the prompt.

3. **Slash commands still hit the LLM.** Replacing `output.parts` in `command.execute.before` substitutes the template, but opencode still calls the model with the resulting user message. Truly local, no-LLM command execution is not yet supported by the hook API.

4. **Vector store is fire-and-forget.** Embedding new notes during injection is done with `Promise.allSettled` without awaiting the batch. A restart before the batch completes leaves those notes un-embedded until the next injection cycle.

5. **Reflection runs in-process.** The consolidation pass calls the Sonnet model synchronously inside the `event` hook handler. Long consolidation runs block the event loop for that session.

## Tests

```bash
cd packages/opencode
bun test test/plugin/obsidian-memory/
# Expected: 484 tests passing across 30 test files
```

Coverage includes: frontmatter parse/serialize round-trip, scope detection (remote, no-remote, detached HEAD, long branches), vault fingerprint stability, note ordering, path construction, injector byte-identity and truncation across all three injection styles, command handlers (save/list/show/stats/suggested/approve/reject) with path-traversal guard, capture gate batching and suggest-mode routing, BM25 and PageRank scoring, HyDE expansion, hybrid retrieval, file reference verification, git event detection, session summary construction, reflection gating, auto-init, vector store upsert and removal, and full hook flow integration tests with fake inputs.
