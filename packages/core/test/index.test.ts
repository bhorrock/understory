import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { SearchIndex } from "../src/index/search-index.js";
import { openIndexDb } from "../src/index/db.js";
import { Bundle } from "../src/okf/bundle.js";

/**
 * Whether native SQLite (with FTS5) is loadable in this environment. When not,
 * the whole suite is skipped — the naive-scan fallback is exercised elsewhere.
 */
const canNative = await (async (): Promise<boolean> => {
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE _probe USING fts5(x)");
    db.close();
    return true;
  } catch {
    return false;
  }
})();

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Doc {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Create a temp bundle, write the docs through a KB, then close it. */
async function makeBundle(docs: Doc[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-test-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const kb = new KnowledgeBase(root);
  for (const d of docs) {
    await kb.writeConcept(d.path, d.frontmatter as never, d.body, `add ${d.path}`);
  }
  await kb.close();
  return root;
}

async function openIndex(root: string): Promise<SearchIndex> {
  const idx = await SearchIndex.open(new Bundle(root));
  expect(idx).not.toBeNull();
  cleanup.push(() => idx!.close());
  return idx!;
}

function trackKb(kb: KnowledgeBase): KnowledgeBase {
  cleanup.push(() => kb.close());
  return kb;
}

describe.skipIf(!canNative)("FTS search index", () => {
  describe("ranking", () => {
    it("ranks a title match above a body-only match", async () => {
      const root = await makeBundle([
        {
          path: "/tables/customers.md",
          frontmatter: { type: "Table", title: "Customers", description: "CRM records" },
          body: "Holds email addresses.",
        },
        {
          path: "/apis/billing.md",
          frontmatter: { type: "API", title: "Billing API" },
          body: "Charges customers monthly.",
        },
      ]);
      const idx = await openIndex(root);
      const hits = await idx.search("customers");
      expect(hits.length).toBe(2);
      expect(hits[0].path).toBe("/tables/customers.md");
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
    });

    it("handles a basic multi-term query", async () => {
      const root = await makeBundle([
        {
          path: "/a.md",
          frontmatter: { type: "T", title: "Monthly Billing" },
          body: "invoices",
        },
        {
          path: "/b.md",
          frontmatter: { type: "T", title: "Unrelated" },
          body: "nothing here",
        },
      ]);
      const idx = await openIndex(root);
      const hits = await idx.search("monthly billing");
      expect(hits[0].path).toBe("/a.md");
      expect(hits.map((h) => h.path)).not.toContain("/b.md");
    });
  });

  describe("filters", () => {
    it("filters by type (case-insensitive, in SQL)", async () => {
      const root = await makeBundle([
        {
          path: "/tables/customers.md",
          frontmatter: { type: "Table", title: "Customers" },
          body: "customers here",
        },
        {
          path: "/apis/billing.md",
          frontmatter: { type: "API Endpoint", title: "Billing" },
          body: "charges customers",
        },
      ]);
      const idx = await openIndex(root);
      const hits = await idx.search("customers", { type: "api endpoint" });
      expect(hits.map((h) => h.path)).toEqual(["/apis/billing.md"]);
    });

    it("filters by tags (post-filtered from files.tags JSON)", async () => {
      const root = await makeBundle([
        {
          path: "/x.md",
          frontmatter: { type: "T", title: "X", tags: ["crm", "core"] },
          body: "shared token",
        },
        {
          path: "/y.md",
          frontmatter: { type: "T", title: "Y", tags: ["billing"] },
          body: "shared token",
        },
      ]);
      const idx = await openIndex(root);
      const hits = await idx.search("shared", { tags: ["CRM"] });
      expect(hits.map((h) => h.path)).toEqual(["/x.md"]);
    });

    it("browse mode: empty query with a tag filter returns matching files at score 1", async () => {
      const root = await makeBundle([
        {
          path: "/x.md",
          frontmatter: { type: "T", title: "X", tags: ["crm"] },
          body: "aaa",
        },
        {
          path: "/y.md",
          frontmatter: { type: "T", title: "Y", tags: ["billing"] },
          body: "bbb",
        },
      ]);
      const idx = await openIndex(root);
      const hits = await idx.search("   ", { tags: ["crm"] });
      expect(hits.map((h) => h.path)).toEqual(["/x.md"]);
      expect(hits[0].score).toBe(1);
      expect(hits[0].snippet).toBeUndefined();
    });

    it("browse mode: empty query with a type filter returns all of that type", async () => {
      const root = await makeBundle([
        { path: "/a.md", frontmatter: { type: "Table", title: "A" }, body: "x" },
        { path: "/b.md", frontmatter: { type: "Table", title: "B" }, body: "y" },
        { path: "/c.md", frontmatter: { type: "API", title: "C" }, body: "z" },
      ]);
      const idx = await openIndex(root);
      const hits = await idx.search("", { type: "Table" });
      expect(hits.map((h) => h.path).sort()).toEqual(["/a.md", "/b.md"]);
    });
  });

  describe("content-hash sync (never mtime)", () => {
    it("re-indexes an out-of-band edit even when mtime is restored", async () => {
      const root = await makeBundle([
        {
          path: "/note.md",
          frontmatter: { type: "T", title: "Note" },
          body: "the original alpha content",
        },
      ]);
      // Baseline: original content is indexed, new word absent.
      {
        const idx = await openIndex(root);
        expect((await idx.search("alpha")).length).toBe(1);
        expect((await idx.search("zephyrium")).length).toBe(0);
        idx.close();
      }

      const abs = path.join(root, "note.md");
      const before = await fs.stat(abs);
      const raw = await fs.readFile(abs, "utf-8");
      const edited = raw.replace("the original alpha content", "now mentions zephyrium instead");
      await fs.writeFile(abs, edited, "utf-8");
      // Restore the previous timestamps so mtime is UNCHANGED — only the hash differs.
      await fs.utimes(abs, before.atime, before.mtime);
      const after = await fs.stat(abs);
      expect(after.mtime.getTime()).toBe(before.mtime.getTime());

      const idx2 = await openIndex(root);
      expect((await idx2.search("zephyrium")).map((h) => h.path)).toEqual(["/note.md"]);
      expect((await idx2.search("alpha")).length).toBe(0);
    });

    it("removes an out-of-band deleted file from results after resync", async () => {
      const root = await makeBundle([
        { path: "/keep.md", frontmatter: { type: "T", title: "Keep" }, body: "widget" },
        { path: "/gone.md", frontmatter: { type: "T", title: "Gone" }, body: "widget" },
      ]);
      const idx = await openIndex(root);
      expect((await idx.search("widget")).length).toBe(2);

      await fs.rm(path.join(root, "gone.md"));
      await idx.afterMutation();
      const hits = await idx.search("widget");
      expect(hits.map((h) => h.path)).toEqual(["/keep.md"]);
    });
  });

  describe("corrupted db resilience", () => {
    it("falls back to naive scan, then rebuilds cleanly on a later open", async () => {
      const root = await makeBundle([
        {
          path: "/doc.md",
          frontmatter: { type: "T", title: "Doc" },
          body: "searchable haystack",
        },
      ]);
      const dbPath = path.join(root, ".index", "index.db");
      // Overwrite the index db (and drop wal/shm) with garbage bytes.
      for (const s of ["-wal", "-shm"]) await fs.rm(dbPath + s, { force: true });
      await fs.writeFile(dbPath, "this is not a sqlite database at all", "utf-8");

      // kb still answers — via the naive fallback.
      const kb = trackKb(new KnowledgeBase(root));
      const hits = await kb.search("haystack");
      expect(hits.map((h) => h.path)).toEqual(["/doc.md"]);

      // The corrupt file was removed by the failed open; a fresh open rebuilds.
      const idx = await openIndex(root);
      expect((await idx.search("haystack")).map((h) => h.path)).toEqual(["/doc.md"]);
      // And the db file exists again and is a real database.
      await expect(fs.access(dbPath)).resolves.toBeUndefined();
    });
  });

  describe("query-syntax safety", () => {
    it("does not throw on punctuation-heavy or unbalanced-quote queries", async () => {
      const root = await makeBundle([
        {
          path: "/billing.md",
          frontmatter: { type: "T", title: "Billing" },
          body: "charges and invoices",
        },
      ]);
      const idx = await openIndex(root);
      // These go straight to the FTS layer (no naive fallback) so a broken MATCH
      // string would surface as a thrown error here.
      await expect(idx.search('billing" OR x(')).resolves.toBeInstanceOf(Array);
      await expect(idx.search('"')).resolves.toBeInstanceOf(Array);
      await expect(idx.search(") AND (")).resolves.toBeInstanceOf(Array);
    });
  });

  describe("SearchHit contract", () => {
    it("returns objects with exactly the expected keys and types", async () => {
      const root = await makeBundle([
        {
          path: "/c.md",
          frontmatter: { type: "Table", title: "Customers", description: "CRM records" },
          body: "This body mentions customers and email.",
        },
      ]);
      const idx = await openIndex(root);
      const hits = await idx.search("customers");
      expect(hits.length).toBe(1);
      const hit = hits[0];

      const allowed = new Set(["path", "type", "title", "description", "snippet", "score"]);
      for (const key of Object.keys(hit)) expect(allowed.has(key)).toBe(true);

      expect(typeof hit.path).toBe("string");
      expect(typeof hit.type).toBe("string");
      expect(typeof hit.score).toBe("number");
      if (hit.title !== undefined) expect(typeof hit.title).toBe("string");
      if (hit.description !== undefined) expect(typeof hit.description).toBe("string");
      if (hit.snippet !== undefined) expect(typeof hit.snippet).toBe("string");
    });
  });

  describe("chunk population (Phase 4 sync)", () => {
    it("populates the chunks table with identity-prefixed, unembedded rows", async () => {
      const root = await makeBundle([
        {
          path: "/tables/customers.md",
          frontmatter: { type: "Table", title: "Customers", description: "CRM records" },
          body: "Holds email addresses.\n\n# Detail\nmore text here",
        },
      ]);
      const idx = await openIndexDb(root);
      expect(idx).not.toBeNull();
      cleanup.push(() => idx!.db.close());
      const rows = idx!.db
        .prepare("SELECT seq, text, embedded FROM chunks WHERE path = ? ORDER BY seq")
        .all("/tables/customers.md") as { seq: number; text: string; embedded: number }[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const r of rows) {
        expect(r.embedded).toBe(0);
        expect(r.text.startsWith("Customers — CRM records:\n")).toBe(true);
      }
    });
  });

  describe("openIndexDb", () => {
    it("opens with a schema and reports vec availability as a boolean", async () => {
      const root = await makeBundle([]);
      const idx = await openIndexDb(root);
      expect(idx).not.toBeNull();
      cleanup.push(() => idx!.db.close());
      expect(typeof idx!.vecAvailable).toBe("boolean");
      const row = idx!.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      expect(row?.value).toBe("1");
    });
  });
});
