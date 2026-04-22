import { Database } from "bun:sqlite"
import path from "path"
import { promises as fs } from "fs"
import type { GraphNode, GraphEdge } from "./types"

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  language TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  language TEXT NOT NULL,
  parent_name TEXT,
  signature TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT NOT NULL,
  extra TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  kind TEXT NOT NULL,
  src TEXT NOT NULL,
  tgt TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'certain',
  UNIQUE(kind, src, tgt, file_path, line_number)
);

CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_tgt ON edges(tgt);
CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file_path);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  qualified_name,
  name,
  file_path,
  signature,
  content='nodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, qualified_name, name, file_path, signature)
  VALUES (new.rowid, new.qualified_name, new.name, new.file_path, COALESCE(new.signature, ''));
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, qualified_name, name, file_path, signature)
  VALUES ('delete', old.rowid, old.qualified_name, old.name, old.file_path, COALESCE(old.signature, ''));
  INSERT INTO nodes_fts(rowid, qualified_name, name, file_path, signature)
  VALUES (new.rowid, new.qualified_name, new.name, new.file_path, COALESCE(new.signature, ''));
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, qualified_name, name, file_path, signature)
  VALUES ('delete', old.rowid, old.qualified_name, old.name, old.file_path, COALESCE(old.signature, ''));
END;
`

export function openDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true })
  db.exec(SCHEMA)
  return db
}

export async function ensureDb(dbPath: string): Promise<Database> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true })
  return openDb(dbPath)
}

export function migrate(_db: Database): void {}

export function getFileHash(db: Database, filePath: string): string | null {
  const row = db.query<{ hash: string }, [string]>("SELECT hash FROM files WHERE path = ?").get(filePath)
  return row?.hash ?? null
}

export function deleteFileGraph(db: Database, filePath: string): void {
  db.run("DELETE FROM edges WHERE file_path = ?", [filePath])
  db.run("DELETE FROM nodes WHERE file_path = ?", [filePath])
  db.run("DELETE FROM files WHERE path = ?", [filePath])
}

export function upsertNode(db: Database, node: GraphNode): void {
  db.run(
    `INSERT INTO nodes (id, kind, name, qualified_name, file_path, line_start, line_end, language, parent_name, signature, is_test, file_hash, extra, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(qualified_name) DO UPDATE SET
       kind=excluded.kind, name=excluded.name, file_path=excluded.file_path,
       line_start=excluded.line_start, line_end=excluded.line_end,
       language=excluded.language, parent_name=excluded.parent_name,
       signature=excluded.signature, is_test=excluded.is_test,
       file_hash=excluded.file_hash, extra=excluded.extra, updated_at=excluded.updated_at`,
    [
      node.id,
      node.kind,
      node.name,
      node.qualifiedName,
      node.filePath,
      node.lineStart,
      node.lineEnd,
      node.language,
      node.parentName ?? null,
      node.signature ?? null,
      node.isTest ? 1 : 0,
      node.fileHash,
      node.extra ? JSON.stringify(node.extra) : null,
      node.updatedAt,
    ],
  )
}

export function upsertEdge(db: Database, edge: GraphEdge): void {
  db.run(
    `INSERT OR IGNORE INTO edges (kind, src, tgt, file_path, line_number, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [edge.kind, edge.srcQualifiedName, edge.tgtQualifiedName, edge.filePath, edge.lineNumber, edge.confidence],
  )
}

const insertNodeStrict = (db: Database, node: GraphNode) =>
  db.run(
    `INSERT INTO nodes (id, kind, name, qualified_name, file_path, line_start, line_end, language, parent_name, signature, is_test, file_hash, extra, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      node.id,
      node.kind,
      node.name,
      node.qualifiedName,
      node.filePath,
      node.lineStart,
      node.lineEnd,
      node.language,
      node.parentName ?? null,
      node.signature ?? null,
      node.isTest ? 1 : 0,
      node.fileHash,
      node.extra ? JSON.stringify(node.extra) : null,
      node.updatedAt,
    ],
  )

export function storeFileBatch(
  db: Database,
  filePath: string,
  hash: string,
  language: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const tx = db.transaction(() => {
    db.run(
      `INSERT INTO files (path, hash, language, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, language=excluded.language, updated_at=excluded.updated_at`,
      [filePath, hash, language, Date.now()],
    )
    for (const node of nodes) insertNodeStrict(db, node)
    for (const edge of edges) upsertEdge(db, edge)
  })
  tx()
}
