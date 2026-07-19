import {
  embedTexts,
  embedderId,
  type EmbeddingConfig,
} from "../providers/index.js";
import { ensureVecTable, vecTableExists, type IndexDb } from "./db.js";

/** How many chunks to embed per endpoint round-trip. */
const BATCH_SIZE = 16;
/** Backoff bounds for a flaky/unavailable embedding endpoint. */
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Query-embedding cache size. */
const QUERY_CACHE_SIZE = 32;

type WorkerState = "cold" | "warming" | "warm" | "error";

interface ChunkRow {
  id: number;
  text: string;
}

/**
 * Background embedder. Drains unembedded chunks in serial batches, writing
 * vectors into the vec0 table, yielding between batches so it never blocks the
 * event loop. Endpoint failures trigger exponential backoff (1s..60s) and are
 * never fatal — the search path degrades to BM25 while the worker keeps retrying.
 *
 * The dimensionality is learned from the first successful response (unless
 * pinned by config), at which point the vec table is created.
 */
export class EmbedWorker {
  private running = false;
  private stopped = false;
  private dims: number | null;
  private backoffMs = BACKOFF_MIN_MS;
  private state: WorkerState = "cold";
  private readonly queryCache = new Map<string, number[]>();

  constructor(
    private readonly idx: IndexDb,
    private readonly cfg: EmbeddingConfig
  ) {
    this.dims = cfg.dims ?? null;
    // If dims are known up-front, create the vec table now so query paths and
    // out-of-band vec cleanup in sync can see it immediately.
    if (this.dims != null) {
      ensureVecTable(this.idx.db, embedderId(cfg.baseURL, cfg.model, this.dims), this.dims);
    }
  }

  /** No unembedded chunks remain and at least one vector has been written. */
  get warm(): boolean {
    if (this.dims == null || !vecTableExists(this.idx.db)) return false;
    const row = this.idx.db
      .prepare(`SELECT 1 FROM chunks WHERE embedded = 0 LIMIT 1`)
      .get();
    return row === undefined;
  }

  /** Schedule a drain if one is not already running. */
  kick(): void {
    if (this.stopped || this.running) return;
    this.running = true;
    // Detach: never let a drain error surface into the caller.
    setImmediate(() => {
      void this.drain().finally(() => {
        this.running = false;
      });
    });
  }

  /** Embed a query, with a small LRU cache. Throws on endpoint failure. */
  async embedQuery(query: string): Promise<number[]> {
    const cached = this.queryCache.get(query);
    if (cached) {
      // Refresh LRU recency.
      this.queryCache.delete(query);
      this.queryCache.set(query, cached);
      return cached;
    }
    const [vector] = await embedTexts(this.cfg, [query]);
    this.queryCache.set(query, vector);
    if (this.queryCache.size > QUERY_CACHE_SIZE) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    return vector;
  }

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    const { db } = this.idx;
    while (!this.stopped) {
      const rows = db
        .prepare(`SELECT id, text FROM chunks WHERE embedded = 0 ORDER BY id LIMIT ?`)
        .all(BATCH_SIZE) as ChunkRow[];
      if (rows.length === 0) {
        this.setState("warm");
        return;
      }
      this.setState("warming");

      let vectors: number[][];
      try {
        vectors = await embedTexts(
          this.cfg,
          rows.map((r) => r.text)
        );
        this.backoffMs = BACKOFF_MIN_MS; // reset on success
      } catch (err) {
        this.setState("error", (err as Error).message);
        await sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        continue; // keep retrying; never crash
      }

      if (this.dims == null && vectors.length > 0) {
        this.dims = vectors[0].length;
        ensureVecTable(db, embedderId(this.cfg.baseURL, this.cfg.model, this.dims), this.dims);
      }

      const insertVec = db.prepare(
        `INSERT OR REPLACE INTO vec (chunk_id, embedding) VALUES (?, vec_f32(?))`
      );
      const markEmbedded = db.prepare(`UPDATE chunks SET embedded = 1 WHERE id = ?`);
      const writeBatch = db.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          // sqlite-vec 0.1.9 requires the primary key bound as a BigInt.
          insertVec.run(BigInt(rows[i].id), toFloat32Buffer(vectors[i]));
          markEmbedded.run(rows[i].id);
        }
      });
      writeBatch();

      // Yield between batches so a large backlog never starves the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private setState(next: WorkerState, detail?: string): void {
    if (this.state === next) return;
    this.state = next;
    // Log once per transition (keeps a warming→warm cycle to two lines).
    if (next === "warming") {
      console.error("[understory] embedding index: warming");
    } else if (next === "warm") {
      console.error("[understory] embedding index: warm");
    } else if (next === "error") {
      console.error(`[understory] embedding index: endpoint error, backing off (${detail ?? ""})`);
    }
  }
}

function toFloat32Buffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
