import type { SearchHit } from "../okf/types.js";
import type { SearchOptions } from "../okf/search.js";
import type { IndexDb } from "./db.js";
import { ftsSearch } from "./fts-search.js";
import type { EmbedWorker } from "./embedder.js";

/**
 * Reciprocal Rank Fusion. Each ranked list contributes `1 / (k + rank)` (rank is
 * 1-based) to every key it contains; the per-key contributions are summed. A key
 * ranked highly in several lists thus outscores one ranked highly in only one —
 * agreement is rewarded, and the `k` constant damps how much any single top rank
 * dominates. Pure and order-independent across lists.
 */
export function rrfFuse(rankedLists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const key = list[i];
      const contribution = 1 / (k + i + 1);
      scores.set(key, (scores.get(key) ?? 0) + contribution);
    }
  }
  return scores;
}

interface FileRow {
  path: string;
  type: string | null;
  title: string | null;
  description: string | null;
  tags: string | null;
}

/**
 * Hybrid BM25 ∪ vector search fused with RRF. When the vector tier is not warm,
 * the extension is unavailable, or the query is empty, this is exactly the
 * Phase 3 BM25-only path (`ftsSearch`) — the tiered-degradation invariant.
 *
 * Otherwise: BM25 top-50 and a path-level KNN top-50 are RRF-fused, rescored
 * (`fused × 1000`), filtered by type/tags, and the top `limit` are returned with
 * metadata drawn from the FTS/files rows (vector-only hits use their description
 * as the snippet).
 */
export async function hybridSearch(
  idx: IndexDb,
  worker: EmbedWorker | null,
  query: string,
  options: SearchOptions = {}
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  const useVector = !!worker && worker.warm && idx.vecAvailable && trimmed.length > 0;
  if (!useVector) {
    // Exact Phase 3 behavior.
    return ftsSearch(idx, query, options);
  }

  const limit = options.limit ?? 20;
  const bm25 = ftsSearch(idx, query, { ...options, limit: 50 });

  let vecPaths: string[];
  try {
    const qvec = await worker!.embedQuery(trimmed);
    vecPaths = knnPaths(idx, qvec, 50);
  } catch {
    // Vector path failed at query time — degrade to BM25-only.
    return ftsSearch(idx, query, options);
  }

  const bmPaths = bm25.map((h) => h.path);
  const fused = rrfFuse([bmPaths, vecPaths]);

  // Rank paths by fused score (desc); stable tie-break on path for determinism.
  const rankedPaths = [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path]) => path);

  const bmByPath = new Map(bm25.map((h) => [h.path, h]));
  const fileByPath = loadFileRows(idx, rankedPaths);
  const wantTags = options.tags?.length ? options.tags.map((t) => t.toLowerCase()) : null;

  const hits: SearchHit[] = [];
  for (const path of rankedPaths) {
    const file = fileByPath.get(path);
    if (!file) continue; // path fell out of the index between queries
    if (options.type && (file.type ?? "").toLowerCase() !== options.type.toLowerCase()) continue;
    if (wantTags) {
      const rowTags = parseTags(file.tags).map((t) => t.toLowerCase());
      if (!wantTags.every((t) => rowTags.includes(t))) continue;
    }

    const bmHit = bmByPath.get(path);
    const hit: SearchHit = {
      path,
      type: file.type ?? "unknown",
      score: (fused.get(path) ?? 0) * 1000,
    };
    const title = bmHit?.title ?? file.title ?? undefined;
    const description = bmHit?.description ?? file.description ?? undefined;
    // A BM25 hit carries a body snippet; a vector-only hit uses its description.
    const snippet = bmHit?.snippet ?? (description || undefined);
    if (title != null) hit.title = title;
    if (description != null) hit.description = description;
    if (snippet !== undefined) hit.snippet = snippet;
    hits.push(hit);
    if (hits.length >= limit) break;
  }

  return hits;
}

/**
 * Path-level KNN: the `k` nearest chunk vectors collapsed to their concept path,
 * keeping each path's closest (minimum) distance. Returned nearest-first.
 * sqlite-vec 0.1.9 uses the `AND k = ?` KNN constraint form.
 */
function knnPaths(idx: IndexDb, queryVector: number[], k: number): string[] {
  const buf = Buffer.from(new Float32Array(queryVector).buffer);
  const rows = idx.db
    .prepare(
      `SELECT c.path AS path, MIN(distance) AS d
         FROM vec JOIN chunks c ON c.id = vec.chunk_id
        WHERE embedding MATCH vec_f32(?) AND k = ?
        GROUP BY c.path
        ORDER BY d`
    )
    .all(buf, k) as { path: string; d: number }[];
  return rows.map((r) => r.path);
}

function loadFileRows(idx: IndexDb, paths: string[]): Map<string, FileRow> {
  const out = new Map<string, FileRow>();
  if (paths.length === 0) return out;
  const placeholders = paths.map(() => "?").join(", ");
  const rows = idx.db
    .prepare(
      `SELECT path, type, title, description, tags FROM files WHERE path IN (${placeholders})`
    )
    .all(...paths) as FileRow[];
  for (const r of rows) out.set(r.path, r);
  return out;
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
