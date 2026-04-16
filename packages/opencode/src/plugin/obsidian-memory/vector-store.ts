import { Database } from "bun:sqlite"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_vectors (
  path TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
`

export interface VectorStore {
  upsert(path: string, vector: Float32Array, hash?: string): void
  hasHash(path: string, hash: string): boolean
  search(query: Float32Array, limit: number): Array<{ path: string; score: number }>
  paths(): string[]
  remove(path: string): void
  close(): void
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export function createVectorStore(dbPath: string): VectorStore {
  const db = new Database(dbPath, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(SCHEMA)
  try {
    db.exec("ALTER TABLE memory_vectors ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
  } catch {
    void 0
  }

  return {
    upsert(path, vector, hash) {
      db.query(
        "INSERT OR REPLACE INTO memory_vectors (path, vector, content_hash, updated_at) VALUES (?, ?, ?, ?)",
      ).run(path, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), hash ?? "", Date.now())
    },

    hasHash(path, hash) {
      const row = db.query("SELECT content_hash FROM memory_vectors WHERE path = ?").get(path) as
        | { content_hash: string }
        | null
      return row !== null && row.content_hash === hash
    },

    search(query, limit) {
      const rows = db
        .query("SELECT path, vector FROM memory_vectors")
        .all() as Array<{ path: string; vector: Uint8Array }>
      return rows
        .map((row) => {
          const clean = row.vector.slice()
          return {
            path: row.path,
            score: cosine(query, new Float32Array(clean.buffer)),
          }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },

    paths() {
      return (db.query("SELECT path FROM memory_vectors").all() as Array<{ path: string }>).map((r) => r.path)
    },

    remove(path) {
      db.query("DELETE FROM memory_vectors WHERE path = ?").run(path)
    },

    close() {
      db.close()
    },
  }
}
