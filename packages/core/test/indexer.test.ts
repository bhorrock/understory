import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, regenerateIndex } from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "indexer-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function indexPath(dir: string): string {
  const rel = dir === "/" ? "" : dir.replace(/^\//, "");
  return path.join(root, rel, "index.md");
}

describe("incremental index regen equivalence", () => {
  it("produces byte-identical index.md to a from-scratch regen after a leaf mutation", async () => {
    // Build a multi-level bundle through the cached mutation path.
    await kb.writeConcept("/apis/billing.md", { type: "API", title: "Billing", description: "Billing endpoints" }, "b", "Added billing.");
    await kb.writeConcept("/apis/v2/payments.md", { type: "API", title: "Payments", description: "v2 payments" }, "b", "Added payments.");
    await kb.writeConcept("/apis/v2/refunds.md", { type: "API", title: "Refunds", description: "v2 refunds" }, "b", "Added refunds.");
    await kb.writeConcept("/tables/customers.md", { type: "Table", title: "Customers", description: "Customer table" }, "b", "Added customers.");
    await kb.writeConcept("/tables/orders.md", { type: "Table", title: "Orders", description: "Orders table" }, "b", "Added orders.");

    // Mutate a single leaf — only its ancestor chain is invalidated/regenerated.
    await kb.patchConcept("/apis/v2/payments.md", { frontmatter: { description: "v2 payments (updated)" } }, "Updated payments.");

    const dirs = ["/", "/apis", "/apis/v2", "/tables"];

    // Snapshot what the cached path wrote, then compare to an uncached from-scratch regen.
    for (const dir of dirs) {
      const cached = await fs.readFile(indexPath(dir), "utf-8");
      const fromScratch = await regenerateIndex(kb.bundle, dir); // no cache argument
      expect(cached, `index.md for ${dir}`).toBe(fromScratch);
    }
  });
});
