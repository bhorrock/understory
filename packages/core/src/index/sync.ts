import { createHash } from "node:crypto";
import type { Bundle } from "../okf/bundle.js";
import type { IndexDb } from "./db.js";

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
}

interface FileRow {
  path: string;
  hash: string;
  type: string | null;
  title: string | null;
  description: string | null;
  /** JSON-encoded string array. */
  tags: string;
  body: string;
}

/**
 * Bring the FTS index in line with the bundle on disk. Staleness is decided by
 * a sha256 content hash — never mtime, which git checkouts mangle. Each changed
 * or removed file is written in its own transaction across the files/fts/chunks
 * tables so a mid-sync crash leaves the index consistent per-row.
 */
export async function syncIndex(bundle: Bundle, idx: IndexDb): Promise<SyncResult> {
  const { db } = idx;
  const result: SyncResult = { added: 0, updated: 0, removed: 0 };

  const existing = new Map<string, string>();
  for (const r of db.prepare(`SELECT path, hash FROM files`).all() as {
    path: string;
    hash: string;
  }[]) {
    existing.set(r.path, r.hash);
  }

  const upsertFile = db.prepare(
    `INSERT INTO files (path, hash, type, title, description, tags, indexed_at)
     VALUES (@path, @hash, @type, @title, @description, @tags, @indexed_at)
     ON CONFLICT(path) DO UPDATE SET
       hash = excluded.hash, type = excluded.type, title = excluded.title,
       description = excluded.description, tags = excluded.tags,
       indexed_at = excluded.indexed_at`
  );
  const deleteFts = db.prepare(`DELETE FROM fts WHERE path = ?`);
  const insertFts = db.prepare(
    `INSERT INTO fts (path, title, description, tags, body)
     VALUES (@path, @title, @description, @tags, @body)`
  );
  const deleteChunks = db.prepare(`DELETE FROM chunks WHERE path = ?`);
  const deleteFile = db.prepare(`DELETE FROM files WHERE path = ?`);

  const writeFile = db.transaction((row: FileRow) => {
    const indexed_at = new Date().toISOString();
    upsertFile.run({
      path: row.path,
      hash: row.hash,
      type: row.type,
      title: row.title,
      description: row.description,
      tags: row.tags,
      indexed_at,
    });
    // FTS5 has no UPDATE-by-rowid we can rely on here; delete + insert the row.
    deleteFts.run(row.path);
    insertFts.run({
      path: row.path,
      title: row.title ?? "",
      description: row.description ?? "",
      tags: tagsToText(row.tags),
      body: row.body,
    });
    // Changed content invalidates any embeddings; Phase 4 re-populates chunks.
    deleteChunks.run(row.path);
  });

  const removeFile = db.transaction((path: string) => {
    deleteFts.run(path);
    deleteChunks.run(path);
    deleteFile.run(path);
  });

  const seen = new Set<string>();
  const paths = await bundle.listConceptPaths();
  for (const conceptPath of paths) {
    seen.add(conceptPath);
    let concept;
    try {
      concept = await bundle.readConcept(conceptPath);
    } catch {
      continue; // Permissive: skip unreadable files (mirrors the naive scan).
    }
    const hash = sha256(concept.raw);
    const prior = existing.get(conceptPath);
    if (prior === hash) continue; // Unchanged.

    const fm = concept.frontmatter;
    const tags = Array.isArray(fm.tags) ? fm.tags.map((t) => String(t)) : [];
    writeFile({
      path: conceptPath,
      hash,
      type: typeof fm.type === "string" ? fm.type : null,
      title: typeof fm.title === "string" ? fm.title : null,
      description: typeof fm.description === "string" ? fm.description : null,
      tags: JSON.stringify(tags),
      body: concept.body,
    });
    if (prior === undefined) result.added++;
    else result.updated++;
  }

  for (const priorPath of existing.keys()) {
    if (!seen.has(priorPath)) {
      removeFile(priorPath);
      result.removed++;
    }
  }

  return result;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** The fts `tags` column is a plain-text join of the tag list for tokenizing. */
function tagsToText(tagsJson: string): string {
  try {
    const arr = JSON.parse(tagsJson);
    return Array.isArray(arr) ? arr.map((t) => String(t)).join(" ") : "";
  } catch {
    return "";
  }
}
