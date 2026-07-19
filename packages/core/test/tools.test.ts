import { describe, it, expect } from "vitest";
import { formatTree, formatTreeAdaptive } from "../src/agent/index.js";
import type { TreeNode } from "../src/okf/index.js";

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
