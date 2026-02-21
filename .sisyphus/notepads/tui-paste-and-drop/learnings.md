## [2026-02-21] Session ses_382961d1effek55DYc2WJeSChP — Atlas initialization

### Key Architecture Facts

- **data: vs file:// URLs**: Clipboard binary (Ctrl+V) → `data:` URL (base64 inline). Drag-dropped file paths → `file://` URL (deferred read at submit). NEVER mix these up.
- **pasteImage()**: Lines 696-737 in prompt/index.tsx. Uses `data:${mime};base64,${content}`. Pattern for extmark creation: `input.visualCursor.offset`, `input.extmarks.create({ start, end, virtual: true, styleId: pasteStyleId, typeId: promptPartTypeId })`, `setStore(produce(...))`.
- **onPaste handler**: Lines 914-981. Current bug: line 932 strips quotes/escapes for ONE filepath, then lines 935-961 handle it. Multi-line paste goes to `[Pasted ~N lines]` at line 964.
- **pathToFileURL**: Used in autocomplete.tsx line 2 (imported from "bun"). NOT imported in prompt/index.tsx — needs to be added.
- **Filesystem utilities**: `Filesystem.exists()`, `Filesystem.isDir()`, `Filesystem.mimeType()`, `Filesystem.readArrayBuffer()` — use these, NOT raw fs APIs.
- **clipboard.ts Linux bug**: Lines 58-67 hardcode `wl-paste -t image/png` with NO `$WAYLAND_DISPLAY` check, NO `Bun.which()` guard. Write side (lines 86-96) does check both. Fix: add same guards, add MIME discovery via `wl-paste --list-types` / `xclip -t TARGETS -o`.

### Existing Single-Path Parse Pattern (must preserve):
```ts
// line 932 — applied per-line in multi-file detection:
const filepath = pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
```

### File Locations
- `clipboard.ts`: `packages/opencode/src/cli/cmd/tui/util/clipboard.ts` (159 lines)
- `prompt/index.tsx`: `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` (1155 lines)
- `autocomplete.tsx`: `packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx`
- `filesystem.ts`: `packages/opencode/src/util/filesystem.ts`
- Build: `./packages/opencode/script/build.ts --single` from repo root
- Typecheck: `bun run typecheck` from repo root

## [2026-02-20] Task 1 — Linux clipboard MIME discovery

- Updated `Clipboard.read()` Linux branch to discover MIME types dynamically before reading image data.
- Detection now mirrors write-side style: Wayland uses `process.env["WAYLAND_DISPLAY"] && Bun.which("wl-paste")`; X11 fallback uses `Bun.which("xclip")` in `else if`.
- Added ordered MIME priority for reads: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/bmp`.
- All Linux subprocesses now use `.nothrow().quiet()` and return actual discovered MIME instead of hardcoded `image/png`.
- `bun run typecheck` passed from repo root after the change.
- Environment lacked `WAYLAND_DISPLAY`, `wl-copy`, `wl-paste`, and `convert`, so runtime clipboard QA evidence files were captured as blocked-by-environment outputs.

## [2026-02-21] Task 3 — WezTerm Drag-and-Drop Format Research

### Key Discovery: `quote_dropped_files` Configuration

WezTerm's drag-and-drop is **configurable** via `quote_dropped_files` setting (since v20220624-141144-bd1b7c5d):
- **Default (Linux/macOS)**: `"SpacesOnly"` — backslash-escape spaces only
- **Windows default**: `"Windows"` — double-quote if spaces
- **Other modes**: `"None"`, `"Posix"`, `"WindowsAlwaysQuoted"`

### Format Evidence

**Single file**: `/path/to/file` or `/path/to/my\ file.txt` (backslash-escaped spaces)

**Multiple files**: **Newline-separated** (one per line)
```
/home/user/file1.png
/home/user/file2.pdf
/home/user/my\ file.txt
```

**NOT file:// URIs** — WezTerm sends bare absolute paths, not `file://` format.

### Validation Against Existing Code

Line 932 in `prompt/index.tsx`:
```typescript
const filepath = pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
```

This **exactly matches** WezTerm's `SpacesOnly` mode:
1. Strips single quotes (if present)
2. Unescapes backslash-spaces to spaces

### Task 4 Recommendation

For multi-file parsing, apply the same per-line logic:
```typescript
const lines = pastedContent.split('\n').filter(line => line.trim())
const filepaths = lines.map(line => 
  line.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
)
```

This handles:
- ✅ SpacesOnly mode (default)
- ✅ Posix mode (if user configured)
- ✅ Single files (one line)
- ✅ Multiple files (newline-separated)
- ✅ Mixed quoting per line
- ✅ Empty lines (filtered)

### Sources

- WezTerm docs: https://wezterm.org/config/lua/config/quote_dropped_files.html
- GitHub #640: Drag & Drop files/folders (closed, implemented)
- WezTerm v20240203-110809-5046fc22 (current environment)
- Evidence file: `.sisyphus/evidence/task-3-wezterm-format.md`

## [2026-02-21] Task 2 — pasteFile() Implementation Complete

### Implementation Summary
- **File**: `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- **Lines**: 740-793 (54 lines)
- **Import added**: Line 5 — `import { pathToFileURL } from "bun"`

### Key Implementation Details

#### Path Normalization (lines 742-745)
```ts
let fp = filepath
if (fp.startsWith("file://")) fp = decodeURIComponent(new URL(fp).pathname)
if (fp.startsWith("~/")) fp = path.join(process.env["HOME"] ?? "~", fp.slice(2))
if (!path.isAbsolute(fp)) fp = path.resolve(sync.data.path.directory || process.cwd(), fp)
```
- Handles file:// URLs from drag-drop
- Expands tilde (~) to HOME
- Resolves relative paths against working directory

#### Validation & Metadata (lines 748-754)
- Silent return if file doesn't exist (no error toast)
- Detects directories vs files
- Uses `Filesystem.mimeType()` for MIME detection
- Virtual text: `[File: name]` or `[Dir: name/]`

#### Extmark Creation (lines 757-769)
- **Identical to pasteImage()** pattern
- Uses `input.visualCursor.offset` for positioning
- Registers with `pasteStyleId` and `promptPartTypeId`
- Stores extmark→part mapping

#### FilePart Creation (lines 775-785)
- **URL**: `pathToFileURL(fp).href` → `file:///absolute/path`
- **NOT** `data:` URL (key difference from pasteImage)
- **MIME**: `"inode/directory"` for dirs
- **source.path**: Relative path from working directory

### Pattern Consistency
✅ Matches pasteImage() exactly for:
- Extmark creation structure
- setStore(produce(...)) pattern
- Virtual text positioning
- Part index tracking

### Differences from pasteImage()
- Uses `file://` URLs instead of `data:` URLs
- Handles directory detection
- Validates file existence
- Normalizes paths (tilde, relative, file://)

### Ready for Integration
The function is now ready to be called from:
1. `onPaste` handler (for pasted file paths)
2. Drag-drop handler (for dropped files)
3. Task 4 will route image files to pasteImage(), non-images to pasteFile()

## [2026-02-21] Task 4 — onPaste multi-file path attach

- Inserted a multi-file detection block in `prompt/index.tsx` immediately after `filepath` normalization and before `isUrl` detection.
- Logic now splits paste payload by newline, trims/filters empty lines, applies existing per-line normalization (`strip quotes`, `unescape \ `), resolves `file://`, `~/`, and relative paths, then checks `Filesystem.exists()` for all lines.
- When all lines resolve to existing paths, paste is intercepted and each path is attached independently:
  - raster images (`image/*` except SVG) are loaded as base64 and sent through `pasteImage()`
  - everything else routes through `pasteFile()` (including directories and SVG)
- If any line is not a valid existing path, handler falls through to existing behavior unchanged: URL/single-file checks and `[Pasted ~N lines]` summary for multiline text.
- `bun run typecheck` from repo root passed (`Tasks: 12 successful, 12 total`).

## [2026-02-20] Task 5 — Build, Full QA, and Regression Test

### Build Results
- `bun run typecheck`: PASS (12/12 packages, all cached, 143ms)
- `./packages/opencode/script/build.ts --single`: PASS (binary at dist/opencode-linux-x64/bin/opencode, 151MB)

### QA Scenarios — All PASS

| Scenario | Status | Evidence |
|----------|--------|----------|
| Full build succeeds | PASS | `.sisyphus/evidence/task-5-build.txt` |
| Cross-task integration (Tasks 1-4) | PASS | `.sisyphus/evidence/task-5-cross-task.txt` |
| Directory drag edge case | PASS | `.sisyphus/evidence/task-5-directory.txt` |
| Nonexistent file in multi-file paste | PASS | `.sisyphus/evidence/task-5-nonexistent-in-multi.txt` |

### Key Verifications
- **Task 1 (clipboard.ts)**: MIME discovery via `wl-paste --list-types` / `xclip -t TARGETS -o` confirmed present with environment guards.
- **Task 2 (pasteFile)**: 54-line function at lines 740-793 with path normalization (file://, ~/, relative), existence validation, directory detection, file:// URL generation via `pathToFileURL` from `"bun"`.
- **Task 3 (research)**: No code changes — validated format assumptions in Tasks 2 and 4.
- **Task 4 (onPaste)**: Multi-file detection at lines 989-1017 with `Promise.all(resolved.map(fp => Filesystem.exists(fp)))` and `allExist.every(Boolean)` gate. Falls through to text paste if ANY path is invalid.
- **Directory handling**: `Filesystem.isDir()` check → `[Dir: name/]` virtual text, `inode/directory` MIME.
- **No bugs found** during code review. All implementations match design spec.
