import type { SearchHit } from "../okf/types.js";
import type { SearchOptions } from "../okf/search.js";
import type { IndexDb } from "./db.js";

/**
 * BM25 column weights, positional over the fts columns
 * (path UNINDEXED, title, description, tags, body). path's weight is inert
 * because the column is unindexed; the rest mirror the naive scan's ranking:
 * title > description = tags > body.
 */
const BM25_WEIGHTS = "8, 4, 2, 2, 1";

interface Row {
  path: string;
  type: string | null;
  title: string | null;
  description: string | null;
  tags: string | null;
  snip?: string | null;
  rank?: number;
}

/**
 * Full-text search over the derived index, returning the exact SearchHit
 * contract the naive scan produces. Query terms are individually double-quoted
 * (with internal quotes escaped) and OR-joined so arbitrary punctuation can
 * never break the FTS5 MATCH grammar. An empty/whitespace query with filters is
 * a browse over the files table (FTS5 errors on an empty MATCH).
 */
export function ftsSearch(idx: IndexDb, query: string, options: SearchOptions = {}): SearchHit[] {
  const { db } = idx;
  const limit = options.limit ?? 20;
  const wantTags = options.tags?.length
    ? options.tags.map((t) => t.toLowerCase())
    : null;

  const match = buildMatch(query);

  let rows: Row[];
  if (match === "") {
    // Browse mode: no MATCH, everything (optionally type-filtered) at score 1.
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.type) {
      where.push(`lower(type) = lower(?)`);
      params.push(options.type);
    }
    const sql = `SELECT path, type, title, description, tags FROM files
      ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
    rows = db.prepare(sql).all(...params) as Row[];
  } else {
    const where: string[] = [`fts MATCH ?`];
    const params: unknown[] = [match];
    if (options.type) {
      where.push(`lower(f.type) = lower(?)`);
      params.push(options.type);
    }
    const sql = `SELECT f.path AS path, f.type AS type, f.title AS title,
        f.description AS description, f.tags AS tags,
        snippet(fts, 4, '', '', '…', 12) AS snip,
        bm25(fts, ${BM25_WEIGHTS}) AS rank
      FROM fts JOIN files f ON f.path = fts.path
      WHERE ${where.join(" AND ")}
      ORDER BY rank`;
    rows = db.prepare(sql).all(...params) as Row[];
  }

  const hits: SearchHit[] = [];
  for (const r of rows) {
    if (wantTags) {
      const rowTags = parseTags(r.tags).map((t) => t.toLowerCase());
      if (!wantTags.every((t) => rowTags.includes(t))) continue;
    }
    const snippet = r.snip && r.snip.trim() ? r.snip.trim() : undefined;
    const hit: SearchHit = {
      path: r.path,
      type: r.type ?? "unknown",
      score: match === "" ? 1 : -(r.rank ?? 0),
    };
    if (r.title != null) hit.title = r.title;
    if (r.description != null) hit.description = r.description;
    if (snippet !== undefined) hit.snippet = snippet;
    hits.push(hit);
  }

  return hits.slice(0, limit);
}

/** Build a punctuation-safe FTS5 MATCH string; "" signals browse mode. */
function buildMatch(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const arr = JSON.parse(tagsJson);
    return Array.isArray(arr) ? arr.map((t) => String(t)) : [];
  } catch {
    return [];
  }
}
