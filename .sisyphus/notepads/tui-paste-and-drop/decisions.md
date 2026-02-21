## [2026-02-21] Session ses_382961d1effek55DYc2WJeSChP — Architectural decisions

### data: vs file:// URL Decision
- **Clipboard binary** → `data:${mime};base64,${content}` (immediate read, inline storage)
- **File paths from drag/paste** → `pathToFileURL(absolutePath).href` = `file:///abs/path` (deferred read at submit)
- Rationale: prompt.ts already resolves file:// URLs at submit time for ALL MIME types. No backend changes needed.

### All-or-nothing File Path Validation
- If ALL non-empty lines are valid file paths → multi-file mode → each becomes separate attachment
- If ANY line is NOT a valid file path → fall through to normal paste (text/[Pasted ~N lines])
- Rationale: prevents false positives where multi-line code/text is mistaken for file paths

### Image MIME Priority Order
PNG > JPEG > WebP > GIF > BMP
(PNG most common, matches existing behavior)

### Virtual Text Format
- Images: `[Image N]` (N = count of image parts + 1) — matches existing pasteImage()
- Non-image files: `[File: filename.ext]` — new format from pasteFile()
- Directories: `[Dir: dirname/]` — new format from pasteFile()
- SVG: `[SVG: filename.svg]` — existing pasteText() call

### Scope Boundaries
- ONLY modify: `clipboard.ts` and `prompt/index.tsx`
- DO NOT touch: `autocomplete.tsx`, `prompt.ts`, `toModelMessages()`, `transform.ts`, `packages/app/`
