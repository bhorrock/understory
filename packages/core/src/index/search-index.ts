import type { Bundle } from "../okf/bundle.js";
import type { SearchHit } from "../okf/types.js";
import type { SearchOptions } from "../okf/search.js";
import {
  normalizeV1,
  resolveEmbeddingConfig,
  resolveEmbeddingModel,
} from "../providers/index.js";
import { openIndexDb, earlyReconcileEmbedder, type IndexDb } from "./db.js";
import { syncIndex, type SyncResult } from "./sync.js";
import { EmbedWorker } from "./embedder.js";
import { hybridSearch } from "./hybrid.js";

/** Which search tier is active, surfaced through GET /api/config. */
export type SearchTier = "naive" | "fts" | "hybrid";

/**
 * Facade over the derived search index. Owns the db handle and (when an
 * embedding endpoint is configured and the vector extension loaded) the
 * background {@link EmbedWorker}. `search()` routes through the hybrid path,
 * which itself degrades to BM25-only until the vector tier is warm.
 */
export class SearchIndex {
  private worker: EmbedWorker | null = null;

  private constructor(
    private readonly bundle: Bundle,
    private readonly idx: IndexDb
  ) {}

  /** True when the vector extension is loaded (BM25-only otherwise). */
  get vecAvailable(): boolean {
    return this.idx.vecAvailable;
  }

  /** "hybrid" when a vector worker is running, else "fts". */
  get tier(): Exclude<SearchTier, "naive"> {
    return this.worker ? "hybrid" : "fts";
  }

  /** Whether every chunk is embedded (vector KNN is contributing to results). */
  get embeddingWarm(): boolean {
    return this.worker?.warm ?? false;
  }

  /**
   * Open the index for a bundle and perform the initial synchronous FTS sync.
   * When `LLM_EMBEDDING_API_BASE_URL` is set and sqlite-vec loaded, spin up the
   * background embed worker (model discovered if unspecified). Returns null when
   * no index db is available (caller falls back to the naive scan).
   */
  static async open(bundle: Bundle, env: NodeJS.ProcessEnv = process.env): Promise<SearchIndex | null> {
    const idx = await openIndexDb(bundle.root);
    if (!idx) return null;
    const self = new SearchIndex(bundle, idx);
    await self.resync();
    await self.maybeStartWorker(env);
    return self;
  }

  private async maybeStartWorker(env: NodeJS.ProcessEnv): Promise<void> {
    const cfg = resolveEmbeddingConfig(env);
    if (!cfg || !this.idx.vecAvailable) return;
    try {
      await resolveEmbeddingModel(cfg);
    } catch (err) {
      console.error(
        `[understory] embedding model discovery failed, staying FTS-only: ${(err as Error).message}`
      );
      return;
    }
    // If the endpoint/model changed since last run, reset stale vectors so the
    // worker actually re-embeds (chunks may all be flagged embedded).
    earlyReconcileEmbedder(this.idx.db, normalizeV1(cfg.baseURL), cfg.model);
    this.worker = new EmbedWorker(this.idx, cfg);
    console.error("[understory] search index: hybrid (embedding worker started)");
    this.worker.kick();
  }

  /** Re-sync after a mutation; the content-hash diff keeps this cheap. */
  async afterMutation(): Promise<SyncResult> {
    const result = await this.resync();
    this.worker?.kick();
    return result;
  }

  private resync(): Promise<SyncResult> {
    return syncIndex(this.bundle, this.idx);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    return hybridSearch(this.idx, this.worker, query, options);
  }

  close(): void {
    this.worker?.stop();
    try {
      this.idx.db.close();
    } catch {
      // best-effort
    }
  }
}
