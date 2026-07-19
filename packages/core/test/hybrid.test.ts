import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { SearchIndex } from "../src/index/search-index.js";
import { ftsSearch } from "../src/index/fts-search.js";
import { rrfFuse } from "../src/index/hybrid.js";
import { chunkConcept } from "../src/index/chunk.js";
import { Bundle } from "../src/okf/bundle.js";
import type { IndexDb } from "../src/index/db.js";

// ── rrfFuse: pure unit tests (no native deps) ─────────────────────────────

describe("rrfFuse", () => {
  it("rewards agreement across lists over a single top rank", () => {
    // 'b' is #2 in both lists; 'a' is #1 in only one. Agreement should win.
    const fused = rrfFuse([
      ["a", "b", "c"],
      ["d", "b", "e"],
    ]);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("a")!);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("d")!);
  });

  it("damps rank dominance via k (larger k flattens the curve)", () => {
    const sharp = rrfFuse([["x", "y"]], 1);
    const flat = rrfFuse([["x", "y"]], 1000);
    const sharpRatio = sharp.get("x")! / sharp.get("y")!;
    const flatRatio = flat.get("x")! / flat.get("y")!;
    expect(sharpRatio).toBeGreaterThan(flatRatio);
    expect(flatRatio).toBeGreaterThan(1); // rank 1 still beats rank 2
  });

  it("unions disjoint lists, each key scored by its single rank", () => {
    const fused = rrfFuse([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect([...fused.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    // Same rank (1) in the only list it appears in → equal scores.
    expect(fused.get("a")).toBeCloseTo(fused.get("c")!);
    expect(fused.get("a")!).toBeGreaterThan(fused.get("b")!);
  });

  it("returns an empty map for empty input", () => {
    expect(rrfFuse([]).size).toBe(0);
    expect(rrfFuse([[], []]).size).toBe(0);
  });
});

// ── chunkConcept: pure unit tests (no native deps) ────────────────────────

describe("chunkConcept", () => {
  const prefixOf = (title: string, description: string) => `${title} — ${description}:\n`;

  it("splits the body on top-level H1 headings (not H2+)", () => {
    const chunks = chunkConcept({
      path: "/a.md",
      frontmatter: { title: "A", description: "d" },
      body: "intro\n\n# One\nalpha\n\n## Sub\nstill one\n\n# Two\nbeta",
    });
    // intro, "# One" section (incl. its ## Sub), "# Two" section → 3 chunks.
    expect(chunks.length).toBe(3);
    expect(chunks[1].text).toContain("# One");
    expect(chunks[1].text).toContain("## Sub");
    expect(chunks[1].text).not.toContain("# Two");
    expect(chunks[2].text).toContain("# Two");
  });

  it("prefixes EVERY chunk with the title — description identity", () => {
    const chunks = chunkConcept({
      path: "/a.md",
      frontmatter: { title: "Widget", description: "a small thing" },
      body: "# H1\nx\n\n# H2\ny",
    });
    const prefix = prefixOf("Widget", "a small thing");
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) expect(ch.text.startsWith(prefix)).toBe(true);
  });

  it("falls back to the path as title and empty description", () => {
    const chunks = chunkConcept({ path: "/dir/thing.md", frontmatter: {}, body: "body" });
    expect(chunks[0].text.startsWith("/dir/thing.md — :\n")).toBe(true);
  });

  it("sub-splits an oversize single paragraph on length", () => {
    const huge = "word ".repeat(700); // ~3500 chars, one paragraph
    const chunks = chunkConcept({
      path: "/a.md",
      frontmatter: { title: "A", description: "d" },
      body: huge,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk's body (minus prefix) stays within the sub-split bound.
    const prefix = prefixOf("A", "d");
    for (const ch of chunks) {
      expect(ch.text.slice(prefix.length).length).toBeLessThanOrEqual(1400);
    }
  });

  it("caps the number of chunks at 24", () => {
    const body = Array.from({ length: 60 }, (_, i) => `# H${i}\ncontent ${i}`).join("\n\n");
    const chunks = chunkConcept({ path: "/a.md", frontmatter: { title: "A", description: "d" }, body });
    expect(chunks.length).toBe(24);
    expect(chunks.map((c) => c.seq)).toEqual([...Array(24).keys()]);
  });

  it("always produces at least one chunk for a bodyless concept", () => {
    const chunks = chunkConcept({ path: "/a.md", frontmatter: { title: "A", description: "d" }, body: "" });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe(prefixOf("A", "d"));
  });
});

// ── Embedding pipeline: deterministic stubbed vectors ─────────────────────

/** sqlite-vec loadable? Gates the whole vector-tier suite. */
const canVec = await (async (): Promise<boolean> => {
  try {
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(":memory:");
    (sqliteVec.load ?? (sqliteVec as { default?: { load?: (d: unknown) => void } }).default?.load)!(
      db as never
    );
    db.exec("CREATE VIRTUAL TABLE _p USING vec0(embedding float[4])");
    db.close();
    return true;
  } catch {
    return false;
  }
})();

/**
 * Deterministic 8-dim embedding: keyword sets map to orthogonal axes, so
 * "car" and "automobile"/"vehicle" land on the same axis (near) while unrelated
 * vocabulary is orthogonal (far). Lets a semantic match be rigged without a
 * real model, and BM25 still can't bridge "car"→"automobile" (no shared term).
 */
const SEM: Record<number, string[]> = {
  0: ["car", "automobile", "vehicle", "motor", "auto", "driving"],
  1: ["banana", "fruit", "apple", "orange", "mango"],
  2: ["billing", "invoice", "payment", "charge"],
};
function embed(text: string, dims = 8): number[] {
  const v = new Array(dims).fill(0);
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of words) {
    for (const [dim, set] of Object.entries(SEM)) {
      if (set.includes(w)) v[Number(dim)] += 1;
    }
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Doc {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

async function makeBundle(docs: Doc[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-test-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const kb = new KnowledgeBase(root);
  for (const d of docs) await kb.writeConcept(d.path, d.frontmatter as never, d.body, `add ${d.path}`);
  await kb.close();
  return root;
}

/**
 * Install a fetch stub answering /v1/embeddings with deterministic vectors.
 * When `gate` is supplied, embedding responses block on it (letting the test
 * observe the pre-warm state); otherwise they resolve immediately. `onCall`
 * runs per embeddings request (used to inject transient failures).
 */
function stubEmbeddings(opts: { gate?: Promise<void>; onCall?: (n: number) => void } = {}): void {
  let n = 0;
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/embeddings")) {
      n++;
      opts.onCall?.(n);
      if (opts.gate) await opts.gate;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
      const data = body.input.map((text, index) => ({ index, embedding: embed(text) }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch);
}

const embeddingEnv = (model = "m1", dims = "8"): NodeJS.ProcessEnv => ({
  LLM_EMBEDDING_API_BASE_URL: "http://embed.test",
  LLM_EMBEDDING_MODEL: model,
  LLM_EMBEDDING_DIMS: dims,
});

async function openHybrid(root: string, env: NodeJS.ProcessEnv): Promise<SearchIndex> {
  const idx = await SearchIndex.open(new Bundle(root), env);
  expect(idx).not.toBeNull();
  cleanup.push(() => idx!.close());
  return idx!;
}

async function waitFor(cond: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

/** Open a fresh read-only connection to inspect the index db directly. */
async function readIndexDb(root: string): Promise<{ unembedded: number; vecRows: number; vecExists: boolean }> {
  const Database = (await import("better-sqlite3")).default;
  const sqliteVec = await import("sqlite-vec");
  const db = new Database(path.join(root, ".index", "index.db"), { readonly: true });
  (sqliteVec.load ?? (sqliteVec as { default?: { load?: (d: unknown) => void } }).default?.load)!(
    db as never
  );
  const unembedded = (db.prepare("SELECT count(*) c FROM chunks WHERE embedded = 0").get() as { c: number }).c;
  const vecExists =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec'").get() !== undefined;
  const vecRows = vecExists ? (db.prepare("SELECT count(*) c FROM vec").get() as { c: number }).c : 0;
  db.close();
  return { unembedded, vecRows, vecExists };
}

describe.skipIf(!canVec)("hybrid vector search", () => {
  it("finds a semantic match that BM25 misses — only once warm", async () => {
    const root = await makeBundle([
      {
        path: "/vehicles/automobile.md",
        frontmatter: { type: "Thing", title: "Automobile", description: "a road machine" },
        body: "A four-wheeled motor vehicle used for personal road transport.",
      },
      {
        path: "/food/banana.md",
        frontmatter: { type: "Thing", title: "Banana", description: "a fruit" },
        body: "A long curved yellow fruit that grows in tropical climates.",
      },
    ]);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stubEmbeddings({ gate });
    const idx = await openHybrid(root, embeddingEnv());

    // Pre-warm: worker is blocked on the gate → BM25-only, identical to fts.
    expect(idx.embeddingWarm).toBe(false);
    expect(await idx.search("car")).toEqual([]); // BM25 can't bridge car→automobile
    // Non-empty case: search() matches ftsSearch exactly while cold.
    const rawIdx = (idx as unknown as { idx: IndexDb }).idx;
    const ftsAuto = ftsSearch(rawIdx, "automobile", {});
    expect(await idx.search("automobile")).toEqual(ftsAuto);

    // Release embeddings and let the worker warm up.
    release();
    await waitFor(() => idx.embeddingWarm);

    // Post-warm: the semantic match surfaces even though "car" appears nowhere.
    const hits = await idx.search("car");
    expect(hits.map((h) => h.path)).toContain("/vehicles/automobile.md");

    // Every chunk embedded; vec table populated.
    const state = await readIndexDb(root);
    expect(state.unembedded).toBe(0);
    expect(state.vecRows).toBeGreaterThan(0);
  });

  it("resets stored vectors when the embedder identity changes", async () => {
    const root = await makeBundle([
      { path: "/a.md", frontmatter: { type: "T", title: "Automobile", description: "car" }, body: "motor vehicle" },
    ]);

    // First run: warm up under model m1.
    stubEmbeddings();
    const idx1 = await openHybrid(root, embeddingEnv("m1"));
    await waitFor(() => idx1.embeddingWarm);
    expect((await readIndexDb(root)).vecRows).toBeGreaterThan(0);
    idx1.close();

    // Reopen under a DIFFERENT model, but gate embeddings so we can observe the
    // reset before the worker re-embeds.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stubEmbeddings({ gate });
    const idx2 = await openHybrid(root, embeddingEnv("m2"));
    // The identity change dropped the vectors and reset the embedded flags
    // synchronously during open (before the gated worker can re-embed).
    const afterReset = await readIndexDb(root);
    expect(afterReset.vecRows).toBe(0);
    expect(afterReset.unembedded).toBeGreaterThan(0);
    expect(idx2.embeddingWarm).toBe(false);

    // Let it re-embed under m2 and confirm it warms again.
    release();
    await waitFor(() => idx2.embeddingWarm);
    expect((await readIndexDb(root)).vecRows).toBeGreaterThan(0);
  });

  it("survives transient endpoint failures without crashing", async () => {
    const root = await makeBundle([
      { path: "/a.md", frontmatter: { type: "T", title: "Automobile", description: "car" }, body: "motor vehicle" },
    ]);
    // First two embedding calls reject; the third and beyond succeed.
    stubEmbeddings({
      onCall: (n) => {
        if (n <= 2) throw new Error("endpoint down");
      },
    });
    const idx = await openHybrid(root, embeddingEnv());
    // Backoff is 1s then 2s before the third attempt succeeds (~3s).
    await waitFor(() => idx.embeddingWarm, 15000);
    expect((await readIndexDb(root)).unembedded).toBe(0);
  }, 20000);
});
