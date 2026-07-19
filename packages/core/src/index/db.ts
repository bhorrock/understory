import { promises as fs } from "node:fs";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";

/** better-sqlite3 database instance type (type-only import — no runtime require). */
export type Database = BetterSqlite3.Database;

/** Bumped whenever the on-disk schema changes; a mismatch triggers a rebuild. */
export const SCHEMA_VERSION = 1;

/** Directory (relative to the bundle root) holding the disposable derived index. */
export const INDEX_DIR = ".index";
export const INDEX_DB_FILE = "index.db";

export interface IndexDb {
  db: Database;
  /** True when the sqlite-vec extension loaded (vector tier, Phase 4). */
  vecAvailable: boolean;
  /** Bundle root this index belongs to. */
  root: string;
}

/** Warn at most once per process for a given reason (keeps logs quiet on the fallback path). */
const warned = new Set<string>();
function warnOnce(reason: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.error(`[understory] search index unavailable: ${reason}`);
}

/**
 * Open (creating if needed) the derived FTS/vector index at
 * `<bundle>/.index/index.db`. Returns null — after warning once — on any
 * failure (native module missing, corrupt db, etc.) so callers fall back to the
 * naive scan. The index is disposable derived state: on a schema-version
 * mismatch the data tables are dropped and rebuilt, and a corrupt db file is
 * removed so the next open rebuilds cleanly.
 */
export async function openIndexDb(bundleRoot: string): Promise<IndexDb | null> {
  const root = path.resolve(bundleRoot);
  const indexDir = path.join(root, INDEX_DIR);
  const dbPath = path.join(indexDir, INDEX_DB_FILE);

  let Database: typeof BetterSqlite3;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch (err) {
    warnOnce(`better-sqlite3 not loadable (${(err as Error).message})`);
    return null;
  }

  await fs.mkdir(indexDir, { recursive: true });

  let db: Database | undefined;
  try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    // Touching the schema forces SQLite to actually read the file header, so a
    // corrupt db surfaces here (as "file is not a database") rather than later.
    initSchema(db);
  } catch (err) {
    warnOnce(`could not open index db (${(err as Error).message})`);
    try {
      db?.close();
    } catch {
      // ignore
    }
    // Remove the (likely corrupt) db files so a subsequent open rebuilds cleanly.
    await removeDbFiles(dbPath);
    return null;
  }

  const vecAvailable = await tryLoadVec(db);
  return { db, vecAvailable, root };
}

/** Idempotent DDL. On schema-version mismatch, drop derived tables and recreate. */
function initSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : undefined;

  if (current !== undefined && current !== SCHEMA_VERSION) {
    // Derived/disposable state: drop everything and rebuild from the bundle.
    db.exec(`
      DROP TABLE IF EXISTS fts;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS files;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path        TEXT PRIMARY KEY,
      hash        TEXT NOT NULL,
      type        TEXT,
      title       TEXT,
      description TEXT,
      tags        TEXT,
      indexed_at  TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      path UNINDEXED,
      title,
      description,
      tags,
      body,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      path     TEXT NOT NULL,
      seq      INTEGER NOT NULL,
      text     TEXT NOT NULL,
      embedded INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS chunks_path ON chunks (path);
  `);

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
}

// ── Vector table lifecycle (Phase 4) ──────────────────────────────────────
// The vec0 virtual table is created lazily, once the embedding dimensionality
// is known (either from LLM_EMBEDDING_DIMS or learned from the first response),
// because vec0 requires a fixed `float[N]` width at CREATE time.

function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/** Whether the vec0 virtual table currently exists. */
export function vecTableExists(db: Database): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec'`)
    .get();
  return row !== undefined;
}

/** Drop the vec table and mark every chunk as needing re-embedding. */
function resetVectors(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS vec`);
  db.prepare(`UPDATE chunks SET embedded = 0`).run();
  db.prepare(`DELETE FROM meta WHERE key IN ('embedder_id', 'embedder_dims')`).run();
}

/**
 * Before embedding starts, detect an embedder change that we can already see
 * from the (baseURL, model) pair alone — even without knowing dims yet. This
 * matters because a stale index may have every chunk flagged `embedded = 1`, so
 * without this the worker would find nothing to do and serve vectors from the
 * *previous* model. Returns true when vectors were reset.
 */
export function earlyReconcileEmbedder(db: Database, baseURL: string, model: string): boolean {
  const stored = getMeta(db, "embedder_id");
  if (stored === undefined) return false;
  const prefix = `${baseURL}|${model}|`;
  if (stored.startsWith(prefix)) return false;
  resetVectors(db);
  return true;
}

/**
 * Ensure the vec0 table exists at the given dimensionality and that the stored
 * embedder identity matches `desiredId`. On mismatch the vectors are dropped and
 * chunks reset so the worker re-embeds. Idempotent. Returns true when it reset.
 */
export function ensureVecTable(db: Database, desiredId: string, dims: number): boolean {
  const stored = getMeta(db, "embedder_id");
  let reset = false;
  if (stored !== undefined && stored !== desiredId) {
    resetVectors(db);
    reset = true;
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dims}])`
  );
  setMeta(db, "embedder_id", desiredId);
  setMeta(db, "embedder_dims", String(dims));
  return reset;
}

/** Attempt to load sqlite-vec. Non-fatal: BM25 works without it. */
async function tryLoadVec(db: Database): Promise<boolean> {
  try {
    const mod = (await import("sqlite-vec")) as {
      load?: (db: Database) => void;
      default?: { load?: (db: Database) => void };
    };
    const load = mod.load ?? mod.default?.load;
    if (!load) throw new Error("sqlite-vec has no load()");
    load(db);
    return true;
  } catch (err) {
    warnOnce(`sqlite-vec extension not loadable — vector tier disabled (${(err as Error).message})`);
    return false;
  }
}

async function removeDbFiles(dbPath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await fs.rm(dbPath + suffix, { force: true });
    } catch {
      // best-effort
    }
  }
}
