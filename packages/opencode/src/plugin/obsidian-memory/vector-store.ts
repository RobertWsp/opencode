import { Database } from "bun:sqlite"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_vectors (
  path TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export interface VectorStore {
  upsert(path: string, vector: Float32Array): void
  search(query: Float32Array, limit: number): Array<{ path: string; score: number }>
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

  return {
    upsert(path, vector) {
      db.query(
        "INSERT OR REPLACE INTO memory_vectors (path, vector, updated_at) VALUES (?, ?, ?)",
      ).run(path, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), Date.now())
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

    remove(path) {
      db.query("DELETE FROM memory_vectors WHERE path = ?").run(path)
    },

    close() {
      db.close()
    },
  }
}
