import { Database as BunDatabase } from "bun:sqlite"
import { promises as fs } from "fs"
import path from "path"
import { Log } from "../../util/log"
import { parseFrontmatter } from "./frontmatter"
import { toEntry } from "./parse-entry"
import type { MemoryDoc, MemoryEntry, Scope } from "./types"

const log = Log.create({ service: "plugin.obsidian-memory.index" })

/**
 * SQLite-backed index of the Obsidian vault — companion to the filesystem,
 * never authoritative. Lives at `<vaultRoot>/.memory-index.db` and tracks:
 *
 * - `memories` table: path, metadata, bitemporal fields
 * - `memories_fts` virtual table (FTS5): title + body + tags tokenized
 *
 * The filesystem remains the source of truth. The index is rebuilt
 * incrementally via `upsertFromPath` (called after writeNote/rewriteNote)
 * and fully regenerated via `rebuild` when a fingerprint mismatch is
 * detected (e.g. user edited files in Obsidian directly).
 *
 * Zero external deps: bun:sqlite ships FTS5 out of the box.
 */

export interface IndexedMemory {
  path: string
  title: string
  description: string
  kind: string
  tags: string
  links: string
  importance: number
  created: string
  validFrom: string
  validUntil: string | null
  mtimeMs: number
  size: number
}

export interface FtsHit {
  memory: IndexedMemory
  score: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL,
  tags TEXT NOT NULL,
  links TEXT NOT NULL,
  importance REAL NOT NULL,
  created TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  body_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_valid
  ON memories(valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_mtime
  ON memories(mtime_ms DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
`

export class VaultIndex {
  private db: BunDatabase | null = null
  private dbPath: string

  constructor(vaultRoot: string) {
    this.dbPath = path.join(vaultRoot, ".memory-index.db")
  }

  /** Open or create the SQLite database. Idempotent. */
  open(): void {
    if (this.db) return
    this.db = new BunDatabase(this.dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(SCHEMA)
  }

  close(): void {
    if (!this.db) return
    this.db.close()
    this.db = null
  }

  /** Insert or replace a single memory row + its FTS entry. */
  upsert(doc: MemoryDoc): void {
    this.open()
    const db = this.db!
    const entry = toEntry(doc)
    const row = entryToRow(entry)
    db.query(
      `INSERT OR REPLACE INTO memories
        (path, title, description, kind, tags, links, importance,
         created, valid_from, valid_until, mtime_ms, size, body_hash)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.path,
      row.title,
      row.description,
      row.kind,
      row.tags,
      row.links,
      row.importance,
      row.created,
      row.validFrom,
      row.validUntil,
      row.mtimeMs,
      row.size,
      bodyHash(doc.body),
    )
    // Refresh FTS row
    db.query(`DELETE FROM memories_fts WHERE path = ?`).run(row.path)
    db.query(
      `INSERT INTO memories_fts (path, title, body, tags) VALUES (?, ?, ?, ?)`,
    ).run(row.path, row.title, doc.body, row.tags)
  }

  /** Remove a memory from both tables (use invalidateNote for soft delete instead). */
  delete(filepath: string): void {
    this.open()
    const db = this.db!
    db.query(`DELETE FROM memories WHERE path = ?`).run(filepath)
    db.query(`DELETE FROM memories_fts WHERE path = ?`).run(filepath)
  }

  /**
   * Full-text search via FTS5 BM25. Returns rows ordered by BM25 rank
   * (lower = better in SQLite's bm25 function, inverted here so higher=better).
   * Excludes invalidated memories.
   */
  search(query: string, limit = 20): FtsHit[] {
    this.open()
    const db = this.db!
    if (!query.trim()) return []
    const sanitized = sanitizeFtsQuery(query)
    if (!sanitized) return []

    try {
      const rows = db
        .query(
          `SELECT m.*, bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories m ON memories_fts.path = m.path
           WHERE memories_fts MATCH ?
             AND (m.valid_until IS NULL OR m.valid_until = '' OR m.valid_until > datetime('now'))
           ORDER BY rank ASC
           LIMIT ?`,
        )
        .all(sanitized, limit) as Array<Record<string, unknown>>

      return rows.map((r) => ({
        memory: rowToIndexed(r),
        // Invert BM25: lower rank (more negative) → higher score
        score: -(r["rank"] as number),
      }))
    } catch (err) {
      log.warn("fts search failed", { query: sanitized, error: String(err) })
      return []
    }
  }

  /** Return all currently-valid memories ordered by recency. */
  listAllValid(limit = 100): IndexedMemory[] {
    this.open()
    const db = this.db!
    const rows = db
      .query(
        `SELECT * FROM memories
         WHERE valid_until IS NULL OR valid_until = '' OR valid_until > datetime('now')
         ORDER BY mtime_ms DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>
    return rows.map(rowToIndexed)
  }

  /** Return total row count — used by rebuild decision. */
  count(): number {
    this.open()
    const db = this.db!
    const row = db.query(`SELECT COUNT(*) as n FROM memories`).get() as { n: number } | null
    return row?.n ?? 0
  }

  /**
   * Rebuild the entire index from the filesystem. Called when a stale
   * state is detected (manual vault edit, new install, etc). Safe to
   * call — wipes existing rows and re-inserts everything.
   */
  async rebuild(scope: Scope): Promise<number> {
    this.open()
    const db = this.db!
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec("DELETE FROM memories")
      db.exec("DELETE FROM memories_fts")
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }

    const files: string[] = [
      scope.systemSharedPath,
      scope.repoSharedPath,
      scope.branchSharedPath,
    ]
    try {
      const entries = await fs.readdir(scope.notesDir)
      for (const name of entries) {
        if (name.endsWith(".md")) files.push(path.join(scope.notesDir, name))
      }
    } catch {
      // notes dir missing, fine
    }

    let inserted = 0
    for (const filepath of files) {
      const doc = await loadDoc(filepath)
      if (!doc) continue
      this.upsert(doc)
      inserted++
    }
    log.info("index rebuilt", { inserted, scope: scope.repoSlug })
    return inserted
  }

  /**
   * Reconcile the index after a filesystem-only change. Cheap path check
   * by comparing mtime; calls `upsert` only when content differs.
   */
  async reconcilePath(filepath: string): Promise<"skipped" | "upserted" | "deleted"> {
    this.open()
    const db = this.db!
    const doc = await loadDoc(filepath)
    if (!doc) {
      db.query(`DELETE FROM memories WHERE path = ?`).run(filepath)
      db.query(`DELETE FROM memories_fts WHERE path = ?`).run(filepath)
      return "deleted"
    }
    const row = db
      .query(`SELECT mtime_ms, body_hash FROM memories WHERE path = ?`)
      .get(filepath) as { mtime_ms: number; body_hash: string } | null
    if (row && row.mtime_ms === doc.mtimeMs && row.body_hash === bodyHash(doc.body)) {
      return "skipped"
    }
    this.upsert(doc)
    return "upserted"
  }
}

// ─── helpers ─────────────────────────────────────────────────────

async function loadDoc(filepath: string): Promise<MemoryDoc | null> {
  try {
    const [source, stat] = await Promise.all([
      fs.readFile(filepath, "utf8"),
      fs.stat(filepath),
    ])
    const { meta, body } = parseFrontmatter(source)
    return {
      path: filepath,
      meta,
      body,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }
  } catch {
    return null
  }
}

function entryToRow(entry: MemoryEntry): IndexedMemory {
  return {
    path: entry.doc.path,
    title: entry.title,
    description: entry.description,
    kind: entry.kind,
    tags: entry.tags.join(","),
    links: JSON.stringify(entry.links),
    importance: entry.importance,
    created: entry.created,
    validFrom: entry.validFrom,
    validUntil: entry.validUntil,
    mtimeMs: entry.doc.mtimeMs,
    size: entry.doc.size,
  }
}

function rowToIndexed(row: Record<string, unknown>): IndexedMemory {
  return {
    path: row["path"] as string,
    title: row["title"] as string,
    description: row["description"] as string,
    kind: row["kind"] as string,
    tags: row["tags"] as string,
    links: row["links"] as string,
    importance: row["importance"] as number,
    created: row["created"] as string,
    validFrom: row["valid_from"] as string,
    validUntil: (row["valid_until"] as string | null) || null,
    mtimeMs: row["mtime_ms"] as number,
    size: row["size"] as number,
  }
}

function bodyHash(body: string): string {
  // Cheap deterministic hash — we just need "changed or not"
  let h = 5381
  for (let i = 0; i < body.length; i++) {
    h = ((h << 5) + h + body.charCodeAt(i)) | 0
  }
  return h.toString(16)
}

/**
 * Escape FTS5-special characters in a user query. Quoting tokens avoids
 * the "syntax error" that FTS5 throws on punctuation, parentheses, etc.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/[a-zA-Z0-9][a-zA-Z0-9_-]*/g)
  if (!tokens || tokens.length === 0) return ""
  return tokens.map((t) => `"${t}"`).join(" OR ")
}
