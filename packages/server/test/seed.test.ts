import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "@understory/core";
import { buildSeedMemory, MAX_SEED_CHARS } from "../src/mcp/seed.js";

let root: string;
let kb: KnowledgeBase;

// A long, single-word description so any mid-word truncation is detectable.
const LONG_DESC = Array(40).fill("tokenword").join(" ");
const NOTICE = "\n… (truncated — use memory_query to explore further)";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "seed-test-"));
  kb = new KnowledgeBase(root);

  // Segment "aaa": a hub with high inbound degree plus 14 concepts linking to it.
  await kb.writeConcept(
    "/aaa/hub.md",
    { type: "Hub", title: "Hub", description: "HUBHUBHUB the central hub concept" },
    "The hub. No outbound links.",
    "Added hub."
  );
  for (let i = 0; i < 14; i++) {
    await kb.writeConcept(
      `/aaa/leaf-${i}.md`,
      { type: "Leaf", description: LONG_DESC },
      `Depends on [hub](/aaa/hub.md).`,
      "Added leaf."
    );
  }
  // Filler segments to push the seed over budget and force truncation.
  for (const d of ["bbb", "ccc", "ddd", "eee", "fff"]) {
    for (let i = 0; i < 3; i++) {
      await kb.writeConcept(`/${d}/${d}-${i}.md`, { type: "Leaf", description: LONG_DESC }, "body", "Added filler.");
    }
  }
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("buildSeedMemory", () => {
  it("stays within budget, surfaces the high-degree concept, and cuts cleanly", async () => {
    const seed = await buildSeedMemory(kb);

    // 1. Budget respected.
    expect(seed.length).toBeLessThanOrEqual(MAX_SEED_CHARS);

    // 2. The most-linked concept's description survives ranking (it's ranked first
    //    in the first segment, so it is present even after truncation).
    expect(seed).toContain("HUBHUBHUB the central hub concept");

    // 3. This fixture is large enough to force truncation; assert it happened and
    //    that the cut landed on a word boundary (no partial "tokenword").
    expect(seed.endsWith(NOTICE)).toBe(true);
    const body = seed.slice(0, seed.length - NOTICE.length);
    const lastToken = body.trim().split(/\s+/).pop();
    expect(lastToken).toBe("tokenword");
  });

  it("degrades gracefully (no truncation) for a small bundle", async () => {
    const smallRoot = await fs.mkdtemp(path.join(os.tmpdir(), "seed-small-"));
    const small = new KnowledgeBase(smallRoot);
    await small.writeConcept("/notes/a.md", { type: "Note", description: "short one" }, "b", "Added a.");
    await small.writeConcept("/notes/b.md", { type: "Note", description: "short two" }, "b", "Added b.");

    const seed = await buildSeedMemory(small);
    expect(seed.length).toBeLessThanOrEqual(MAX_SEED_CHARS);
    expect(seed).not.toContain("truncated");
    expect(seed).toContain("short one");
    await fs.rm(smallRoot, { recursive: true, force: true });
  });
});
