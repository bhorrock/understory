import type { Bundle } from "../okf/bundle.js";
import type { SearchHit } from "../okf/types.js";
import type { SearchOptions } from "../okf/search.js";
import { openIndexDb, type IndexDb } from "./db.js";
import { syncIndex, type SyncResult } from "./sync.js";
import { ftsSearch } from "./fts-search.js";

/**
 * Facade over the derived search index. Owns the db handle, keeps it in sync
 * with the bundle via content-hash diffing, and answers queries. `search()` is
 * intentionally the single query entry point so Phase 4 can layer the vector
 * tier (hybrid RRF) in here without touching any caller.
 */
export class SearchIndex {
  private constructor(
    private readonly bundle: Bundle,
    private readonly idx: IndexDb
  ) {}

  /** True when the vector extension is loaded (BM25-only otherwise). */
  get vecAvailable(): boolean {
    return this.idx.vecAvailable;
  }

  /**
   * Open the index for a bundle and perform the initial synchronous sync.
   * Returns null when no index db is available (caller falls back to naive scan).
   */
  static async open(bundle: Bundle): Promise<SearchIndex | null> {
    const idx = await openIndexDb(bundle.root);
    if (!idx) return null;
    const self = new SearchIndex(bundle, idx);
    await self.resync();
    return self;
  }

  /** Re-sync after a mutation; the content-hash diff keeps this cheap. */
  afterMutation(): Promise<SyncResult> {
    return this.resync();
  }

  private resync(): Promise<SyncResult> {
    return syncIndex(this.bundle, this.idx);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    // Phase 4 extends this to hybrid (BM25 ∪ vector KNN, fused) when the vector
    // tier is warm; today it is BM25/FTS only.
    return ftsSearch(this.idx, query, options);
  }

  close(): void {
    try {
      this.idx.db.close();
    } catch {
      // best-effort
    }
  }
}
