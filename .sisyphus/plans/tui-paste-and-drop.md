# TUI Paste & Drop: Multi-Format Clipboard + Multi-File Attachment

## TL;DR

> **Quick Summary**: Fix OpenCode's TUI to properly handle clipboard images in all formats (not just PNG) on Linux, correctly attach multiple files dragged/pasted at once (instead of showing "[Pasted ~4 lines]"), and support non-image file attachments (PDFs, code files, etc.).
> 
> **Deliverables**:
> - Fixed `Clipboard.read()` with dynamic MIME type discovery on Linux (Wayland + X11)
> - New `pasteFile()` function for non-image file attachments using `file://` URLs
> - Rewritten `onPaste` handler with multi-file path detection and per-file attachment
> - Backward-compatible with existing single-file paste and text paste behaviors
> 
> **Estimated Effort**: Medium (3 focused changes in 2 files)
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 (clipboard) and Task 2 (pasteFile) → Task 3 (onPaste rewrite) → Task 4 (build + QA)

---

## Context

### Original Request
User wants to fix OpenCode TUI's clipboard and drag-and-drop handling:
1. Clipboard paste (Ctrl+V) only works for PNG images on Linux — JPEG/WebP/GIF silently fail
2. Dragging multiple files into the terminal shows "[Pasted ~4 lines]" instead of attaching each file
3. Only image files are attachable — PDFs, code files, etc. are not supported as attachments

### Interview Summary
**Key Discussions**:
- Terminal: WezTerm on Linux (Wayland)
- No inline image preview needed — just proper attachment handling
- Any file type should be attachable (not just images)
- Drag-and-drop in terminals works via bracketed paste (file paths as text lines)

**Research Findings**:
- `Clipboard.read()` at clipboard.ts:58-67 hardcodes `image/png` — no MIME discovery
- Write side properly checks `$WAYLAND_DISPLAY` (line 87) but read side doesn't
- `onPaste` handler at prompt/index.tsx:914-981 only handles single file path (line 932)
- Multi-line paste (≥3 lines or >150 chars) triggers "[Pasted ~N lines]" (line 964-971)
- `pasteImage()` uses `data:` URLs (base64 inline) — correct for clipboard binary data
- `insertPart()` in autocomplete.tsx uses `file://` URLs via `pathToFileURL()` — correct for file paths
- `prompt.ts` already handles `file://` URLs at submit time for all MIME types
- `FilePart` schema and all LLM providers support any MIME type

### Metis Review
**Identified Gaps** (addressed):
- **`data:` vs `file://` URLs**: Drag-dropped files MUST use `file://` URLs (deferred read at submit), NOT `data:` URLs (immediate base64). Only clipboard binary uses `data:` URLs.
- **WezTerm drag format**: Need to handle quoted paths, `file://` URIs, and paths with spaces
- **Path validation**: Must check ALL lines are valid file paths before treating as multi-file (otherwise fall through to text paste)
- **Directory handling**: Dragged directories should use `file://` URLs (prompt.ts already handles directories at submit)
- **Tilde expansion**: `~/file.png` must be resolved to absolute path
- **`Bun.which()` guards**: Read side should check tool availability like write side does
- **Virtual text for non-images**: Use `[File: filename.ext]` pattern

---

## Work Objectives

### Core Objective
Make OpenCode TUI correctly handle clipboard images in all formats on Linux, properly attach multiple dragged/pasted files as separate parts, and support non-image file types as attachments.

### Concrete Deliverables
- `clipboard.ts`: Fixed `Clipboard.read()` with MIME discovery via `wl-paste --list-types` / `xclip -t TARGETS -o`
- `prompt/index.tsx`: New `pasteFile()` function using `file://` URLs with `[File: name]` extmark
- `prompt/index.tsx`: Rewritten `onPaste` handler with multi-file detection and per-file attachment
- Rebuilt binary tested on WezTerm

### Definition of Done
- [ ] `wl-copy -t image/jpeg < test.jpg` → Ctrl+V → `[Image 1]` appears with `mime: "image/jpeg"`
- [ ] Drag 3 image files → 3 separate `[Image N]` extmarks, 3 FileParts in store
- [ ] Drag 1 image + 1 PDF → `[Image 1] [File: doc.pdf]`, 2 FileParts
- [ ] Paste 4 lines of code → `[Pasted ~4 lines]` (backward compat preserved)
- [ ] Single file drag → works exactly as before

### Must Have
- Dynamic MIME type discovery on Linux (Wayland + X11)
- Multi-file detection in `onPaste` — each file becomes separate attachment
- Non-image files supported as `file://` URL FileParts
- `file://` URI prefix stripping in pasted paths
- Tilde `~` expansion in file paths
- Proper `$WAYLAND_DISPLAY` + `Bun.which()` guards in clipboard read
- Backward compatibility with single-file paste, text paste, and URL paste

### Must NOT Have (Guardrails)
- ❌ Inline image preview / terminal image protocols (user explicitly excluded)
- ❌ File picker dialog or UI chrome
- ❌ Drop zone visual indicators
- ❌ Changes to macOS or Windows clipboard handling
- ❌ Changes to `autocomplete.tsx`, `prompt.ts`, `toModelMessages()`, or `transform.ts`
- ❌ Changes to `packages/app/` (web app)
- ❌ Reading large files into memory during paste (use `file://` deferred read)
- ❌ File size validation dialogs (acceptable: skip files >50MB with console warning)
- ❌ Audio/video special handling (MIME detection handles naturally)
- ❌ URL fetching for `https://` pasted URLs

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (Bun test, vitest config exists in monorepo)
- **Automated tests**: Tests-after (unit tests for clipboard MIME discovery and path parsing)
- **Framework**: Bun test (project standard)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **TUI interaction**: Use `interactive_bash` (tmux) — Run opencode, send keystrokes, validate output
- **Clipboard**: Use Bash (`wl-copy`, `wl-paste`) — Set clipboard contents, trigger paste
- **Build verification**: Use Bash — Build binary, verify exit code and output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — independent fixes):
├── Task 1: Fix Clipboard.read() MIME discovery [deep]
├── Task 2: Add pasteFile() function for non-image attachments [quick]
└── Task 3: Verify WezTerm drag-and-drop format [quick]

Wave 2 (After Wave 1 — integration):
└── Task 4: Rewrite onPaste multi-file detection [deep]

Wave 3 (After Wave 2 — verification):
└── Task 5: Build, QA, and regression test [unspecified-high]

Wave FINAL (After ALL tasks — independent review):
├── Task F1: Plan compliance audit [oracle]
├── Task F2: Code quality review [unspecified-high]
├── Task F3: Real manual QA [unspecified-high]
└── Task F4: Scope fidelity check [deep]

Critical Path: Task 1+2+3 → Task 4 → Task 5 → F1-F4
Parallel Speedup: ~40% faster than sequential
Max Concurrent: 3 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 4, 5 | 1 |
| 2 | — | 4, 5 | 1 |
| 3 | — | 4 | 1 |
| 4 | 1, 2, 3 | 5 | 2 |
| 5 | 4 | F1-F4 | 3 |
| F1-F4 | 5 | — | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks — T1 → `deep`, T2 → `quick`, T3 → `quick`
- **Wave 2**: 1 task — T4 → `deep`
- **Wave 3**: 1 task — T5 → `unspecified-high`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.
> **A task WITHOUT QA Scenarios is INCOMPLETE. No exceptions.**

- [ ] 1. Fix Clipboard.read() MIME Discovery on Linux

  **What to do**:
  - In `clipboard.ts`, replace the hardcoded `image/png` Linux block (lines 58-67) with dynamic MIME discovery
  - Add `$WAYLAND_DISPLAY` check and `Bun.which()` guards to match the write-side pattern (lines 86-121)
  - **Wayland path**: Check `process.env.WAYLAND_DISPLAY && Bun.which('wl-paste')`. If yes:
    - Run `wl-paste --list-types` (or `-l`) to get available MIME types (one per line on stdout)
    - Filter for `image/*` types
    - Iterate priority list: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/bmp`
    - Read the first available type: `wl-paste -t <mime>` → `.arrayBuffer()` → base64
    - Return `{data: base64, mime: actualMime}`
  - **X11 path**: If not Wayland and `Bun.which('xclip')`. Then:
    - Run `xclip -selection clipboard -t TARGETS -o` to get available atoms (one per line)
    - Filter lines matching `image/*` (ignore X11 atoms like `TIMESTAMP`, `TARGETS`)
    - Iterate same priority list as Wayland
    - Read: `xclip -selection clipboard -t <mime> -o` → `.arrayBuffer()` → base64
    - Return `{data: base64, mime: actualMime}`
  - **Fallback**: If no image found in either path, fall through to `clipboardy.read()` text (existing behavior at line 69)
  - Keep macOS and Windows blocks unchanged
  - All subprocess calls must use `.nothrow().quiet()` to suppress errors

  **Must NOT do**:
  - Do not modify macOS or Windows clipboard code
  - Do not add image preview/rendering
  - Do not add timeout handling (subprocess already has OS-level timeout via Bun)
  - Do not use `xsel` for reading (it doesn't support `-t TARGETS`)

  **Recommended Agent Profile**:
  > Select category + skills based on task domain.
  - **Category**: `deep`
    - Reason: Requires careful subprocess orchestration and error handling across two Linux display server paths
  - **Skills**: []
    - No external skills needed — pure Bun/Node subprocess work
  - **Skills Evaluated but Omitted**:
    - `uv-ruff-python-tools`: Not Python code

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Task 4 (onPaste rewrite depends on improved clipboard)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References** (existing code to follow):
  - `clipboard.ts:86-121` — Write-side `getCopyMethod()`: Shows correct `$WAYLAND_DISPLAY` + `Bun.which()` guard pattern. READ THIS FIRST to match the style.
  - `clipboard.ts:58-67` — Current Linux read block to REPLACE: hardcodes `image/png`, no env check.
  - `clipboard.ts:29-73` — Full `Clipboard.read()` function: Understand the macOS/Windows/Linux/text fallback chain.

  **API/Type References** (contracts to implement against):
  - `clipboard.ts:24-27` — `Content` interface: `{data: string, mime: string}` — return type must match.

  **External References**:
  - `wl-paste --list-types` outputs one MIME per line to stdout. Exit 0 on success, non-zero if no clipboard.
  - `xclip -selection clipboard -t TARGETS -o` outputs one atom name per line. Filter for `image/*` only.
  - `wl-paste -t <mime>` outputs raw binary to stdout.
  - `xclip -selection clipboard -t <mime> -o` outputs raw binary to stdout.

  **WHY Each Reference Matters**:
  - `getCopyMethod()` (write side) is the canonical pattern for Linux display server detection in this codebase — match it exactly
  - The `Content` interface constrains return type — `data` must be base64 string, `mime` must be actual MIME type (not hardcoded `image/png`)

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Clipboard JPEG paste on Wayland
    Tool: Bash + interactive_bash (tmux)
    Preconditions: WAYLAND_DISPLAY is set, wl-paste available, a JPEG image in /tmp/test.jpg
    Steps:
      1. Run: `convert -size 100x100 xc:red /tmp/test.jpg` (create test JPEG) or `curl -o /tmp/test.jpg https://via.placeholder.com/100.jpg`
      2. Run: `wl-copy -t image/jpeg < /tmp/test.jpg`
      3. Launch opencode in tmux session
      4. Send Ctrl+V keystroke
      5. Capture prompt text content
    Expected Result: Prompt shows `[Image 1]` extmark. Store has FilePart with `mime: "image/jpeg"` (NOT `image/png`)
    Failure Indicators: No extmark appears, or mime is `image/png`, or error in stderr
    Evidence: .sisyphus/evidence/task-1-clipboard-jpeg.txt

  Scenario: Clipboard PNG paste still works (backward compat)
    Tool: Bash + interactive_bash
    Preconditions: Same as above with a PNG image
    Steps:
      1. Run: `convert -size 100x100 xc:blue /tmp/test.png`
      2. Run: `wl-copy -t image/png < /tmp/test.png`
      3. Launch opencode, Ctrl+V
    Expected Result: `[Image 1]` with `mime: "image/png"` — same as before
    Evidence: .sisyphus/evidence/task-1-clipboard-png.txt

  Scenario: Empty clipboard graceful no-op
    Tool: Bash + interactive_bash
    Preconditions: Clipboard cleared
    Steps:
      1. Run: `wl-copy --clear` or `wl-copy ""`
      2. Launch opencode, Ctrl+V
    Expected Result: No crash, no extmark, no error. Default paste behavior (nothing happens or empty text)
    Evidence: .sisyphus/evidence/task-1-clipboard-empty.txt

  Scenario: Text clipboard falls through correctly
    Tool: Bash + interactive_bash
    Preconditions: Text in clipboard (no image)
    Steps:
      1. Run: `wl-copy "hello world"`
      2. Launch opencode, Ctrl+V
    Expected Result: "hello world" pasted as text — no image extmark, no crash
    Evidence: .sisyphus/evidence/task-1-clipboard-text.txt
  ```

  **Evidence to Capture:**
  - [ ] task-1-clipboard-jpeg.txt — Ctrl+V with JPEG in clipboard
  - [ ] task-1-clipboard-png.txt — Ctrl+V with PNG (backward compat)
  - [ ] task-1-clipboard-empty.txt — Ctrl+V with empty clipboard
  - [ ] task-1-clipboard-text.txt — Ctrl+V with text in clipboard

  **Commit**: YES
  - Message: `fix(tui): support all image MIME types in Linux clipboard read`
  - Files: `packages/opencode/src/cli/cmd/tui/util/clipboard.ts`
  - Pre-commit: `bun run typecheck`

- [ ] 2. Add pasteFile() Function for Non-Image Attachments

  **What to do**:
  - In `prompt/index.tsx`, add a new `pasteFile()` function AFTER the existing `pasteImage()` function (line 737)
  - This function creates a FilePart with `file://` URL (NOT `data:` URL) and `[File: filename]` virtual text
  - Function signature: `async function pasteFile(filepath: string): Promise<void>`
  - Implementation:
    - Resolve the path: expand `~` to `$HOME`, resolve relative paths against `sync.data.path.directory || process.cwd()`
    - Strip `file://` prefix if present (using `URL` constructor or string ops)
    - Validate file exists with `Filesystem.exists(path)` — return silently if not
    - Check if directory with `Filesystem.isDir(path)` — directories use same `file://` pattern
    - Get filename with `path.basename(resolvedPath)`
    - Get mime with `Filesystem.mimeType(resolvedPath)`
    - Create `file://` URL with `pathToFileURL(resolvedPath).href`
    - Create extmark with `[File: filename]` virtual text (or `[Dir: dirname/]` for directories)
    - Create FilePart following the `insertPart()` pattern from autocomplete.tsx:270-284:
      ```
      {
        type: "file",
        mime: mime,
        filename: filename,
        url: fileUrl,  // file:///absolute/path
        source: { type: "file", path: relPath, text: { start, end, value: virtualText } }
      }
      ```
    - Push to `store.prompt.parts` and map extmark ID
  - Also handle SVG special case: SVG files should be read as text (matching existing pasteImage SVG handling at lines 939-945)
  - For IMAGE files pasted via file path, still use `pasteImage()` with `data:` URL (keeps existing behavior) — `pasteFile()` is for NON-image files only
  - Import `pathToFileURL` from `"bun"` at top of file

  **Must NOT do**:
  - Do not read file contents into memory (no base64 encoding) — `file://` URLs defer to submit time
  - Do not duplicate `pasteImage()` logic — `pasteFile()` is a separate function for non-image files
  - Do not modify `pasteImage()` itself
  - Do not touch `autocomplete.tsx`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Straightforward function following existing patterns — `pasteImage()` for extmark style, `insertPart()` for `file://` URL style
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `software-frontend`: Not React-specific — this is Bun/Node file handling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 4 (onPaste rewrite calls this function)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References** (existing code to follow):
  - `prompt/index.tsx:696-737` — `pasteImage()`: Follow this EXACT pattern for extmark creation and store update. CRITICAL: Match the `produce()` pattern, extmark creation with `pasteStyleId` and `promptPartTypeId`.
  - `autocomplete.tsx:248-284` — `insertPart()` with `pathToFileURL()`: Follow this for `file://` URL creation. Key: `const urlObj = pathToFileURL(fullPath); const url = urlObj.href`.
  - `prompt/index.tsx:939-945` — SVG special case: SVG files are read as text, not image. Replicate this check in `pasteFile()` if SVG file paths come through this path.

  **API/Type References**:
  - `Filesystem.exists(path)` — `filesystem.ts:12` — Returns `Promise<boolean>`
  - `Filesystem.isDir(path)` — `filesystem.ts:16` — Returns `Promise<boolean>`
  - `Filesystem.mimeType(path)` — `filesystem.ts:98` — Returns `string` (extension-based via `mime-types` library)
  - `pathToFileURL` from `"bun"` — Used at `autocomplete.tsx:2` — Converts absolute path to `file:///...` URL
  - `FilePart` type — `@opencode-ai/sdk/v2` — `{type: "file", mime, url, filename?, source?}`

  **WHY Each Reference Matters**:
  - `pasteImage()` is the source of truth for extmark creation in the prompt — `pasteFile()` must use identical extmark mechanics
  - `insertPart()` is the source of truth for `file://` URL creation — `pasteFile()` must use `pathToFileURL()` identically
  - `Filesystem` utilities are the standard file operations in this codebase — don't use raw `fs` APIs

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: pasteFile() creates correct FilePart for PDF
    Tool: Code review + interactive_bash
    Preconditions: opencode built with new pasteFile() function
    Steps:
      1. Verify function exists in prompt/index.tsx after pasteImage()
      2. Verify it uses pathToFileURL() (not data: URL)
      3. Verify extmark virtual text is [File: filename.pdf]
      4. Verify FilePart has type: "file", mime from Filesystem.mimeType(), url starts with "file:///"
    Expected Result: Function follows both pasteImage() extmark pattern AND insertPart() file:// URL pattern
    Evidence: .sisyphus/evidence/task-2-paste-file-code-review.txt

  Scenario: pasteFile() handles tilde path
    Tool: Bash
    Preconditions: File exists at ~/test.pdf
    Steps:
      1. Create test file: `touch ~/test.pdf`
      2. In code, call pasteFile("~/test.pdf")
      3. Verify resolved path is /home/user/test.pdf (not ~/test.pdf)
    Expected Result: Path properly resolved, file:// URL uses absolute path
    Evidence: .sisyphus/evidence/task-2-tilde-expansion.txt

  Scenario: pasteFile() handles nonexistent file gracefully
    Tool: Bash
    Preconditions: No file at /tmp/nonexistent.xyz
    Steps:
      1. Call pasteFile("/tmp/nonexistent.xyz")
    Expected Result: Function returns silently, no extmark created, no crash
    Evidence: .sisyphus/evidence/task-2-nonexistent-file.txt
  ```

  **Evidence to Capture:**
  - [ ] task-2-paste-file-code-review.txt — Code review of pasteFile() implementation
  - [ ] task-2-tilde-expansion.txt — Tilde path resolution test
  - [ ] task-2-nonexistent-file.txt — Graceful handling of missing files

  **Commit**: YES (groups with Task 4)
  - Message: `feat(tui): add pasteFile() for non-image file attachments`
  - Files: `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - Pre-commit: `bun run typecheck`

- [ ] 3. Verify WezTerm Drag-and-Drop Format

  **What to do**:
  - This is a RESEARCH task to determine the exact format WezTerm uses when multiple files are dragged into the terminal
  - Create a simple test script that captures raw bracketed paste input
  - Test with WezTerm by dragging:
    - Single file → capture format
    - Multiple files → capture format
    - Files with spaces in names → capture format
    - Files from different directories → capture format
    - Mix of files and directories → capture format
  - Document the exact format in `.sisyphus/evidence/task-3-wezterm-format.md`
  - The test approach:
    1. In a terminal, run `cat` or `read -r line; echo "$line"` in a loop
    2. Drag files into the terminal
    3. Observe the raw text output
    4. Check: Are paths quoted? Escaped? Absolute? `file://` prefix? One per line?
  - The findings from this task directly inform how Task 4 parses multi-line paste text
  - **Expected format based on research**: WezTerm sends bare absolute paths, one per line, with spaces escaped as `\ ` or paths wrapped in single quotes. But this MUST be verified.

  **Must NOT do**:
  - Do not implement any code changes — this is research only
  - Do not modify any source files

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple terminal observation task
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 4 (parsing logic depends on knowing the format)
  - **Blocked By**: None (can start immediately)

  **References**:

  **External References**:
  - WezTerm docs on drag-and-drop behavior: https://wezfurlong.org/wezterm/
  - Current path parsing in `prompt/index.tsx:932`: `pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")` — strips single quotes and unescapes spaces

  **WHY Each Reference Matters**:
  - The current single-line path parsing (line 932) tells us what format was previously assumed — our multi-file parser must handle the same transformations per-line

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Capture WezTerm single file drag format
    Tool: interactive_bash (tmux)
    Preconditions: WezTerm running, test files exist
    Steps:
      1. Create test files: `touch /tmp/test1.png /tmp/test2.pdf "/tmp/my file.txt"`
      2. Open tmux session, run `cat`
      3. Drag /tmp/test1.png into WezTerm
      4. Observe raw output format
    Expected Result: Document exact format (quoted? escaped? absolute? file:// prefix?)
    Evidence: .sisyphus/evidence/task-3-wezterm-format.md

  Scenario: Capture WezTerm multi-file drag format
    Tool: interactive_bash (tmux)
    Preconditions: Same as above
    Steps:
      1. Select 3 files in file manager
      2. Drag all 3 into WezTerm
      3. Observe raw output — are they newline-separated? Tab-separated?
    Expected Result: Document multi-file delimiter and per-file format
    Evidence: .sisyphus/evidence/task-3-wezterm-format.md

  Scenario: Capture format for files with spaces
    Tool: interactive_bash (tmux)
    Preconditions: File with spaces exists
    Steps:
      1. Drag "/tmp/my file.txt" into WezTerm
      2. Observe: Is path quoted? Backslash-escaped spaces?
    Expected Result: Document space handling
    Evidence: .sisyphus/evidence/task-3-wezterm-format.md
  ```

  **Evidence to Capture:**
  - [ ] task-3-wezterm-format.md — Complete documentation of WezTerm drag-drop format

  **Commit**: NO (research only, no code changes)

- [ ] 4. Rewrite onPaste Handler with Multi-File Detection

  **What to do**:
  - In `prompt/index.tsx`, rewrite the `onPaste` handler (lines 914-981) to detect and handle multi-file paste
  - The handler must be modified BETWEEN the URL check (line 933) and the single-file-path check (line 935)
  - **New logic flow** (replace lines 930-961):
    1. Normalize text: `pastedContent` already normalized (line 923-924)
    2. Skip URLs: `isUrl` check remains unchanged (line 933)
    3. **NEW: Split by newlines**: `const lines = pastedContent.split('\n').filter(l => l.trim())`
    4. **NEW: Per-line path normalization** (using Task 3 findings):
       - Strip single quotes: `line.replace(/^'+|'+$/g, '')`
       - Unescape spaces: `line.replace(/\\ /g, ' ')`
       - Strip `file://` prefix: `if (line.startsWith('file://')) line = decodeURIComponent(new URL(line).pathname)`
       - Expand tilde: `if (line.startsWith('~/')) line = path.join(process.env.HOME || '', line.slice(2))`
       - Resolve relative: `if (!path.isAbsolute(line)) line = path.resolve(sync.data.path.directory || process.cwd(), line)`
    5. **NEW: Validate ALL lines are file paths**: `const allFiles = await Promise.all(lines.map(l => Filesystem.exists(l)))`
    6. **NEW: If ALL non-empty lines are valid files** → `event.preventDefault()` and process each:
       - For each valid file path:
         - If `mime.startsWith('image/')` and not SVG → call `pasteImage({filename, mime, content: base64})` (read file as base64 — same as current single-image behavior)
         - If SVG → call `pasteText(content, '[SVG: filename]')` (same as current lines 939-945)
         - If directory → call `pasteFile(filepath)` (uses file:// URL)
         - Otherwise → call `pasteFile(filepath)` (uses file:// URL)
       - Return after processing all files
    7. **If NOT all lines are files** → fall through to existing logic (single-path check, then [Pasted ~N lines])
  - **Critical: The existing single-file-path behavior at lines 932-961 must be PRESERVED as the fallback**
    - When only 1 line and it's a file → existing single-path logic handles it (no change needed)
    - When multiple lines and ALL are files → new multi-file logic handles it
    - When multiple lines and NOT all files → fall through to `[Pasted ~N lines]`
  - **Key decision from Metis**: Images use `data:` URL (read base64 into memory at paste time), non-images use `file://` URL (deferred read at submit). This matches existing patterns.

  **Must NOT do**:
  - Do not change the URL detection logic (line 933)
  - Do not change the `[Pasted ~N lines]` logic (lines 964-971) — just ensure multi-file paths don't reach it
  - Do not change `pasteImage()` function
  - Do not change `pasteText()` function
  - Do not change the `disable_paste_summary` experimental flag behavior
  - Do not touch `autocomplete.tsx` or `prompt.ts`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex integration logic combining clipboard knowledge, file detection, and multiple code paths. Must preserve backward compat.
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `software-frontend`: This is terminal paste handling, not React UI patterns

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after Wave 1)
  - **Blocks**: Task 5 (build + QA)
  - **Blocked By**: Tasks 1, 2, 3 (needs improved clipboard, pasteFile() function, and WezTerm format knowledge)

  **References** (CRITICAL):

  **Pattern References** (existing code to follow):
  - `prompt/index.tsx:914-981` — Current `onPaste` handler: READ THIS END-TO-END first. Understand every code path before modifying.
  - `prompt/index.tsx:920-928` — Text normalization + empty check: Keep unchanged.
  - `prompt/index.tsx:932` — Single-path quote/escape stripping: Apply this same transform per-line in multi-file detection.
  - `prompt/index.tsx:935-961` — Single file path detection (MIME check, image read, SVG special case): Preserve as fallback for single-line paste.
  - `prompt/index.tsx:964-971` — `[Pasted ~N lines]` text paste: Must still work for non-file multi-line paste.
  - `prompt/index.tsx:696-737` — `pasteImage()`: Call this for image files (same as current behavior).
  - Task 2's `pasteFile()` — Call this for non-image files and directories.
  - `.sisyphus/evidence/task-3-wezterm-format.md` — WezTerm format documentation from Task 3: Use this to inform exact parsing logic.

  **API/Type References**:
  - `Filesystem.exists(path)` — `filesystem.ts:12` — Validates file path exists
  - `Filesystem.isDir(path)` — `filesystem.ts:16` — Checks if path is directory
  - `Filesystem.mimeType(path)` — `filesystem.ts:98` — Extension-based MIME detection
  - `Filesystem.readArrayBuffer(path)` — `filesystem.ts:45` — Read file for base64 (images only)
  - `path.isAbsolute()`, `path.resolve()`, `path.join()`, `path.basename()` — Standard Node path utilities

  **WHY Each Reference Matters**:
  - The current `onPaste` handler is the MOST CRITICAL file — any mistake here breaks ALL paste operations
  - Task 3's WezTerm format docs determine the exact per-line parsing needed
  - `pasteImage()` and `pasteFile()` are the two dispatch targets — the handler just needs to route correctly

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Multi-file drag — 3 images
    Tool: interactive_bash (tmux)
    Preconditions: opencode built and running in tmux, 3 test images exist
    Steps:
      1. Create: `convert -size 50x50 xc:red /tmp/a.png && convert -size 50x50 xc:green /tmp/b.jpg && convert -size 50x50 xc:blue /tmp/c.webp`
      2. Simulate multi-file paste (bracketed paste with 3 paths separated by newlines):
         Send to tmux: `printf '\e[200~/tmp/a.png\n/tmp/b.jpg\n/tmp/c.webp\e[201~'`
      3. Observe prompt content
    Expected Result: `[Image 1] [Image 2] [Image 3]` — three separate extmarks, 3 FileParts in store
    Failure Indicators: `[Pasted ~3 lines]` appears, or only first file attached, or crash
    Evidence: .sisyphus/evidence/task-4-multi-image-drag.txt

  Scenario: Multi-file drag — mixed types (image + PDF + Python)
    Tool: interactive_bash (tmux)
    Preconditions: Files exist at /tmp/photo.png, /tmp/doc.pdf, /tmp/script.py
    Steps:
      1. Create: `convert -size 50x50 xc:red /tmp/photo.png && touch /tmp/doc.pdf /tmp/script.py`
      2. Simulate multi-file paste: 3 paths newline-separated
      3. Observe prompt content
    Expected Result: `[Image 1] [File: doc.pdf] [File: script.py]` — 3 separate attachments
    Failure Indicators: `[Pasted ~3 lines]` or non-image files not attached
    Evidence: .sisyphus/evidence/task-4-mixed-types.txt

  Scenario: Single file drag backward compat
    Tool: interactive_bash (tmux)
    Preconditions: Single image file exists
    Steps:
      1. Simulate single-file paste: `/tmp/photo.png`
      2. Observe prompt content
    Expected Result: `[Image 1]` — exactly same as before this change
    Evidence: .sisyphus/evidence/task-4-single-file-compat.txt

  Scenario: Multi-line text paste backward compat
    Tool: interactive_bash (tmux)
    Preconditions: No file at /tmp/some_code.py (the text is CODE, not paths)
    Steps:
      1. Simulate bracketed paste with 4 lines of Python code:
         `def foo():\n    return 42\n\nprint(foo())`
    Expected Result: `[Pasted ~4 lines]` — existing behavior preserved
    Failure Indicators: Text treated as file paths, or crash, or no paste summary
    Evidence: .sisyphus/evidence/task-4-text-paste-compat.txt

  Scenario: Mixed valid paths and non-path text
    Tool: interactive_bash (tmux)
    Preconditions: /tmp/photo.png exists, but "hello world" is not a path
    Steps:
      1. Simulate paste: `/tmp/photo.png\nhello world`
    Expected Result: Falls through to `[Pasted ~2 lines]` — NOT treated as multi-file (because not ALL lines are valid paths)
    Evidence: .sisyphus/evidence/task-4-mixed-paths-text.txt

  Scenario: File with spaces in name
    Tool: interactive_bash (tmux)
    Preconditions: File exists at `/tmp/my file.png`
    Steps:
      1. Create: `convert -size 50x50 xc:red '/tmp/my file.png'`
      2. Simulate paste with escaped/quoted path (based on Task 3 findings)
    Expected Result: File properly detected and attached as `[Image 1]`
    Evidence: .sisyphus/evidence/task-4-spaces-in-name.txt

  Scenario: file:// URI pasted
    Tool: interactive_bash (tmux)
    Preconditions: /tmp/photo.png exists
    Steps:
      1. Simulate paste: `file:///tmp/photo.png`
    Expected Result: URI stripped to `/tmp/photo.png`, file attached as `[Image 1]`
    Evidence: .sisyphus/evidence/task-4-file-uri.txt
  ```

  **Evidence to Capture:**
  - [ ] task-4-multi-image-drag.txt — 3 images dragged
  - [ ] task-4-mixed-types.txt — Image + PDF + Python dragged
  - [ ] task-4-single-file-compat.txt — Single file backward compat
  - [ ] task-4-text-paste-compat.txt — Multi-line text paste backward compat
  - [ ] task-4-mixed-paths-text.txt — Mixed valid/invalid paths
  - [ ] task-4-spaces-in-name.txt — File with spaces
  - [ ] task-4-file-uri.txt — file:// URI handling

  **Commit**: YES
  - Message: `feat(tui): multi-file detection in onPaste handler`
  - Files: `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - Pre-commit: `bun run typecheck`

- [ ] 5. Build, Full QA, and Regression Test

  **What to do**:
  - Build the binary: `./packages/opencode/script/build.ts --single` from repo root
  - Verify typecheck passes: `bun run typecheck` from repo root
  - Run all QA scenarios from Tasks 1-4 in sequence on the built binary
  - Test cross-task integration scenarios not covered by individual tasks
  - Test edge cases:
    - Empty lines in multi-file paste
    - Very long file paths
    - Nonexistent file in middle of multi-file paste (all-or-nothing: should fall through to text paste)
    - Dragging a directory
    - Pasting a URL (should NOT be treated as file)
    - Rapid successive pastes
  - Save all evidence to `.sisyphus/evidence/`

  **Must NOT do**:
  - Do not modify any source files — this is verification only
  - Do not fix bugs here — report them for re-work in Task 1-4

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Comprehensive QA requiring careful test execution and evidence collection
  - **Skills**: [`playwright`]
    - `playwright`: Useful if any browser-based testing is needed for the web app comparison

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (after all implementation)
  - **Blocks**: Final verification wave
  - **Blocked By**: Task 4

  **References**:
  - All QA scenarios from Tasks 1-4
  - Built binary at `packages/opencode/dist/opencode-linux-x64/bin/opencode`
  - Symlink at `~/.opencode/bin/opencode`

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Full build succeeds
    Tool: Bash
    Steps:
      1. Run: `bun run typecheck` from repo root
      2. Run: `./packages/opencode/script/build.ts --single` from repo root
    Expected Result: Both exit 0, binary exists at expected path
    Evidence: .sisyphus/evidence/task-5-build.txt

  Scenario: Cross-task integration — clipboard paste then drag-drop in same session
    Tool: interactive_bash (tmux)
    Steps:
      1. Paste JPEG from clipboard → [Image 1]
      2. Drag 2 files (PNG + PDF) → [Image 2] [File: doc.pdf]
      3. Verify all 3 parts in prompt
    Expected Result: 3 FileParts total, correct MIME types, correct URLs (data: for clipboard, file:// for drag)
    Evidence: .sisyphus/evidence/task-5-cross-task.txt

  Scenario: Edge case — directory drag
    Tool: interactive_bash (tmux)
    Steps:
      1. Simulate paste of directory path: `/tmp/testdir`
    Expected Result: `[Dir: testdir/]` or `[File: testdir]` extmark, file:// URL
    Evidence: .sisyphus/evidence/task-5-directory.txt

  Scenario: Edge case — nonexistent file in multi-file paste
    Tool: interactive_bash (tmux)
    Steps:
      1. Simulate paste: `/tmp/real.png\n/tmp/nonexistent.xyz`
    Expected Result: Falls through to `[Pasted ~2 lines]` (all-or-nothing: not all paths are valid files)
    Evidence: .sisyphus/evidence/task-5-nonexistent-in-multi.txt
  ```

  **Evidence to Capture:**
  - [ ] task-5-build.txt — Build output
  - [ ] task-5-cross-task.txt — Clipboard + drag integration
  - [ ] task-5-directory.txt — Directory drag handling
  - [ ] task-5-nonexistent-in-multi.txt — Nonexistent file edge case

  **Commit**: NO (verification only)

---
## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run typecheck` from repo root. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify code follows project style (AGENTS.md: single-word vars, const over let, early returns, no destructuring).
  Output: `Build [PASS/FAIL] | Typecheck [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Build binary with `./packages/opencode/script/build.ts --single`. Launch in WezTerm. Test ALL QA scenarios from all tasks. Test cross-task integration (clipboard + drag-drop + non-image files together). Test edge cases: empty clipboard, nonexistent file paths, mixed file+text paste. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Commit | Scope | Message | Files |
|--------|-------|---------|-------|
| 1 | clipboard | `fix(tui): support all image MIME types in Linux clipboard read` | `clipboard.ts` |
| 2 | prompt | `feat(tui): add pasteFile() for non-image file attachments` | `prompt/index.tsx` |
| 3 | prompt | `feat(tui): multi-file detection in onPaste handler` | `prompt/index.tsx` |

---

## Success Criteria

### Verification Commands
```bash
# Build
./packages/opencode/script/build.ts --single  # Expected: exit 0, binary at dist/

# Typecheck
bun run typecheck  # Expected: 0 errors

# Clipboard JPEG test
wl-copy -t image/jpeg < /tmp/test.jpg && echo "Clipboard set"
# Then Ctrl+V in opencode → [Image 1] with mime image/jpeg

# Multi-file drag test
# Drag 3 files into WezTerm → 3 separate [Image/File] extmarks
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] Typecheck passes (0 errors)
- [ ] Build succeeds
- [ ] Backward compat: single file paste works
- [ ] Backward compat: text paste shows "[Pasted ~N lines]"
- [ ] Backward compat: URL paste skipped (not treated as file)
