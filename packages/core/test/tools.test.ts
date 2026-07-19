import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNotation, buildReadTools, formatTree, formatTreeAdaptive } from "../src/agent/index.js";
import { KnowledgeBase, type TreeNode } from "../src/okf/index.js";

function concept(name: string, type: string, description: string): TreeNode {
  return { name, path: `/${name}.md`, kind: "concept", type, title: name, description };
}

/** A directory with `n` concepts, alternating between two types. */
function dir(name: string, n: number, children: TreeNode[] = []): TreeNode {
  const concepts: TreeNode[] = [];
  for (let i = 0; i < n; i++) {
    const type = i % 2 === 0 ? "Table" : "API Endpoint";
    concepts.push({
      name: `${name}-${i}`,
      path: `/${name}/${name}-${i}.md`,
      kind: "concept",
      type,
      title: `${name} ${i}`,
      description: `Description number ${i} for the ${name} segment with enough text to matter.`,
    });
  }
  return { name, path: `/${name}`, kind: "directory", children: [...concepts, ...children] };
}

/** ~200 concepts across four top-level directories, one with a nested subdir. */
function bigTree(): TreeNode {
  const nested = dir("nested", 30);
  return {
    name: "",
    path: "/",
    kind: "directory",
    children: [dir("apis", 60, [nested]), dir("tables", 50), dir("playbooks", 40), dir("decisions", 20)],
  };
}

describe("formatTreeAdaptive", () => {
  it("passes the full listing through when under budget", () => {
    const small: TreeNode = {
      name: "",
      path: "/",
      kind: "directory",
      children: [concept("a", "Note", "first"), concept("b", "Note", "second")],
    };
    const out = formatTreeAdaptive(small, 4000);
    expect(out.degraded).toBe(false);
    expect(out.text).toBe(formatTree(small));
    expect(out.conceptCount).toBe(2);
  });

  it("counts all concepts recursively", () => {
    const out = formatTreeAdaptive(bigTree(), 4000);
    expect(out.conceptCount).toBe(200);
  });

  it("degrades to per-directory lines when the full listing is over budget", () => {
    const tree = bigTree();
    const out = formatTreeAdaptive(tree, 4000);
    expect(out.degraded).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(4000);
    // Directory overview lines carry recursive counts and types, not concept titles.
    expect(out.text).toMatch(/apis\/ — 90 concepts \(API Endpoint, Table\)/);
    expect(out.text).toMatch(/tables\/ — 50 concepts/);
    expect(out.text).not.toContain("apis-0.md");
    // The nested subdirectory still appears at full altitude.
    expect(out.text).toMatch(/nested\/ — 30 concepts/);
  });

  it("caps depth to the top level when even the overview is over budget", () => {
    const out = formatTreeAdaptive(bigTree(), 60);
    expect(out.degraded).toBe(true);
    // Depth-1 cap: top-level dirs present, nested subdir line dropped.
    expect(out.text).toContain("apis/");
    expect(out.text).not.toContain("nested/");
  });
});

/** Minimal ToolExecutionOptions stub for calling a tool's execute() directly. */
const execOpts = { toolCallId: "t", messages: [] } as never;

describe("read_history tool", () => {
  let root: string;
  let kb: KnowledgeBase;
  let midpoint: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "read-history-test-"));
    kb = new KnowledgeBase(root);
    // Three concepts + an update + a deletion → Creation/Update/Deletion events.
    await kb.writeConcept("/apis/billing.md", { type: "API" }, "body", "Added [billing](/apis/billing.md).");
    await kb.writeConcept("/apis/payments.md", { type: "API" }, "body", "Added [payments](/apis/payments.md).");
    midpoint = new Date().toISOString();
    await kb.patchConcept("/apis/billing.md", { replaceBody: "new body" }, "Updated [billing](/apis/billing.md).");
    await kb.writeConcept("/tables/customers.md", { type: "Table" }, "body", "Added [customers](/tables/customers.md).");
    await kb.deleteConcept("/apis/payments.md", "Removed [payments](/apis/payments.md).");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns events newest-first with exactly {ts, action, path, summary}", async () => {
    const out = (await buildReadTools(kb).read_history.execute!(
      { limit: 20 },
      execOpts
    )) as Array<Record<string, unknown>>;
    expect(out.map((e) => e.action)).toEqual(["Deletion", "Creation", "Update", "Creation", "Creation"]);
    // Shape carries only the four reader fields — no traceId/modelChain noise.
    for (const e of out) {
      expect(Object.keys(e).sort()).toEqual(["action", "path", "summary", "ts"]);
    }
  });

  it("filters by path_contains", async () => {
    const out = (await buildReadTools(kb).read_history.execute!(
      { path_contains: "billing", limit: 20 },
      execOpts
    )) as Array<Record<string, unknown>>;
    expect(out.map((e) => e.action)).toEqual(["Update", "Creation"]);
    expect(out.every((e) => String(e.path).includes("billing"))).toBe(true);
  });

  it("filters by action", async () => {
    const out = (await buildReadTools(kb).read_history.execute!(
      { action: "Creation", limit: 20 },
      execOpts
    )) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(3);
    expect(out.every((e) => e.action === "Creation")).toBe(true);
  });

  it("filters by since (inclusive) and caps with limit", async () => {
    const since = (await buildReadTools(kb).read_history.execute!(
      { since: midpoint, limit: 20 },
      execOpts
    )) as Array<Record<string, unknown>>;
    // Only the three mutations after the two initial creations.
    expect(since.map((e) => e.action)).toEqual(["Deletion", "Creation", "Update"]);

    const capped = (await buildReadTools(kb).read_history.execute!(
      { limit: 2 },
      execOpts
    )) as unknown[];
    expect(capped).toHaveLength(2);
  });
});

describe("buildNotation read_history case", () => {
  it("renders `history (N)` with the touched-path count", () => {
    const notation = buildNotation([
      { seq: 1, tool: "read_history", summary: "billing", paths: ["/apis/billing.md", "/apis/payments.md"] },
    ]);
    expect(notation).toBe("history (2) → ✓");
  });
});
