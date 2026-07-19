import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response, Router } from "express";
import { KnowledgeBase, TraceStore, type QueryTrace, type KnowledgeEvent } from "@understory/core";
import { aggregateTraces, aggregateEvents, statsRouter } from "../src/api/stats.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function trace(over: Partial<QueryTrace>): QueryTrace {
  return {
    id: Math.random().toString(36).slice(2),
    kind: "query",
    input: "in",
    startedAt: "2026-07-01T00:00:00.000Z",
    durationMs: 100,
    steps: [],
    answer: "out",
    notation: "✓",
    outcome: "success",
    modelChain: [],
    ...over,
  };
}

function event(over: Partial<KnowledgeEvent>): KnowledgeEvent {
  return {
    ts: "2026-07-18T12:00:00.000Z",
    action: "Update",
    path: "/a.md",
    summary: "did a thing",
    ...over,
  };
}

// ── aggregateTraces ───────────────────────────────────────────────────────────

describe("aggregateTraces", () => {
  it("groups by kind and outcome", () => {
    const stats = aggregateTraces([
      trace({ kind: "query", outcome: "success" }),
      trace({ kind: "query", outcome: "failed" }),
      trace({ kind: "mutation", outcome: "partial" }),
      trace({ kind: "chat", outcome: "success" }),
    ]);
    expect(stats.total).toBe(4);
    expect(stats.byKind).toEqual({ query: 2, mutation: 1, chat: 1 });
    expect(stats.byOutcome).toEqual({ success: 2, partial: 1, failed: 1 });
  });

  it("computes avg/p50/p95 on known values", () => {
    // durations 10..100 (10 values); steps mirror via array length.
    const durs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stats = aggregateTraces(
      durs.map((d, i) =>
        trace({
          durationMs: d,
          steps: Array.from({ length: i + 1 }, (_, s) => ({
            seq: s + 1,
            tool: "read_concept",
            summary: "",
            paths: [],
          })),
        })
      )
    );
    // avg of 10..100 = 55.
    expect(stats.durationMs.avg).toBe(55);
    // nearest-rank: p50 → ceil(0.5*10)=5th smallest = 50; p95 → ceil(0.95*10)=10th = 100.
    expect(stats.durationMs.p50).toBe(50);
    expect(stats.durationMs.p95).toBe(100);
    // steps lengths are 1..10.
    expect(stats.steps.avg).toBe(5.5);
    expect(stats.steps.p50).toBe(5);
    expect(stats.steps.p95).toBe(10);
  });

  it("groups by model chain with failure counts, sorted by count", () => {
    const stats = aggregateTraces([
      trace({ modelChain: ["primary"], outcome: "success" }),
      trace({ modelChain: ["primary"], outcome: "failed" }),
      trace({ modelChain: ["primary", "fallback"], outcome: "partial" }),
    ]);
    expect(stats.byModelChain).toEqual([
      { chain: "primary", count: 2, failures: 1 },
      { chain: "primary→fallback", count: 1, failures: 0 },
    ]);
  });

  it("returns a zeroed shape for empty input (no NaN)", () => {
    const stats = aggregateTraces([]);
    expect(stats).toEqual({
      total: 0,
      byKind: { query: 0, mutation: 0, chat: 0 },
      byOutcome: { success: 0, partial: 0, failed: 0 },
      steps: { avg: 0, p50: 0, p95: 0 },
      durationMs: { avg: 0, p50: 0, p95: 0 },
      byModelChain: [],
    });
    expect(Number.isNaN(stats.steps.avg)).toBe(false);
  });
});

// ── aggregateEvents ───────────────────────────────────────────────────────────

describe("aggregateEvents", () => {
  const now = new Date("2026-07-18T09:30:00.000Z");

  it("buckets perDay over a fixed window; boundaries inclusive at both edges", () => {
    const stats = aggregateEvents(
      [
        event({ ts: "2026-07-18T23:59:59.000Z" }), // today (window end, inclusive)
        event({ ts: "2026-07-18T00:00:00.000Z" }), // today, same bucket
        event({ ts: "2026-06-19T00:00:00.000Z" }), // exactly 29 days back = window start (inclusive)
        event({ ts: "2026-06-18T23:59:59.000Z" }), // 30 days back = just outside (exclusive)
      ],
      30,
      now
    );
    expect(stats.perDay.length).toBe(30);
    expect(stats.perDay[0].date).toBe("2026-06-19"); // oldest bucket = start of window
    expect(stats.perDay[29].date).toBe("2026-07-18"); // newest bucket = now's day
    expect(stats.perDay[29].count).toBe(2); // two events land on today
    expect(stats.perDay[0].count).toBe(1); // the 29-days-back event is inside
    // The 30-days-back event falls outside the 30-day window → not in any bucket.
    const bucketed = stats.perDay.reduce((s, d) => s + d.count, 0);
    expect(bucketed).toBe(3);
  });

  it("counts byAction across all events", () => {
    const stats = aggregateEvents(
      [
        event({ action: "Creation" }),
        event({ action: "Creation" }),
        event({ action: "Update" }),
        event({ action: "Deletion" }),
      ],
      30,
      now
    );
    expect(stats.byAction).toEqual({ Creation: 2, Update: 1, Deletion: 1 });
    expect(stats.total).toBe(4);
  });

  it("ranks topPaths descending and caps at 10", () => {
    const events: KnowledgeEvent[] = [];
    // 12 distinct paths with descending frequency: /p0 x12 … /p11 x1.
    for (let p = 0; p < 12; p++) {
      for (let n = 0; n < 12 - p; n++) events.push(event({ path: `/p${p}.md` }));
    }
    const stats = aggregateEvents(events, 30, now);
    expect(stats.topPaths.length).toBe(10);
    expect(stats.topPaths[0]).toEqual({ path: "/p0.md", count: 12 });
    expect(stats.topPaths[9]).toEqual({ path: "/p9.md", count: 3 });
    // /p10 and /p11 are dropped by the cap.
    expect(stats.topPaths.some((t) => t.path === "/p11.md")).toBe(false);
  });

  it("ignores empty paths in topPaths (backfilled events)", () => {
    const stats = aggregateEvents([event({ path: "" }), event({ path: "/x.md" })], 30, now);
    expect(stats.topPaths).toEqual([{ path: "/x.md", count: 1 }]);
  });

  it("returns a zeroed shape for empty input", () => {
    const stats = aggregateEvents([], 30, now);
    expect(stats.total).toBe(0);
    expect(stats.byAction).toEqual({});
    expect(stats.topPaths).toEqual([]);
    expect(stats.perDay.length).toBe(30);
    expect(stats.perDay.every((d) => d.count === 0)).toBe(true);
  });
});

// ── Router-level ──────────────────────────────────────────────────────────────

/** Pull the GET /stats handler out of the router and invoke it with mock req/res. */
function statsHandler(router: Router): (req: Request, res: Response) => Promise<void> {
  // express Router keeps route layers in `.stack`; find the /stats GET handler.
  const layer = (router as unknown as { stack: any[] }).stack.find(
    (l) => l.route?.path === "/stats"
  );
  if (!layer) throw new Error("no /stats route mounted");
  const handle = layer.route.stack[0].handle;
  return handle;
}

describe("statsRouter GET /stats", () => {
  let root: string;
  let kb: KnowledgeBase;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "stats-test-"));
    kb = new KnowledgeBase(root);
    // Real mutations → real events in .events.jsonl.
    await kb.writeConcept("/notes/a.md", { type: "Note", description: "a" }, "body", "Added a.");
    await kb.writeConcept("/notes/b.md", { type: "Note", description: "b" }, "body", "Added b.");
    await kb.patchConcept("/notes/a.md", { replaceBody: "changed" }, "Edited a.");
    // A saved trace file.
    await new TraceStore(root).save({
      id: "test-trace-1",
      kind: "query",
      input: "hi",
      startedAt: "2026-07-18T00:00:00.000Z",
      durationMs: 42,
      steps: [{ seq: 1, tool: "search_knowledge", summary: "q", paths: ["/notes/a.md"] }],
      answer: "there",
      notation: 'search "q" (1) → ✓',
      outcome: "success",
      modelChain: ["primary"],
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns 200 with the full payload shape from live sources", async () => {
    const handler = statsHandler(statsRouter(kb));
    let statusCode = 200;
    let body: any;
    const res = {
      status(c: number) {
        statusCode = c;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;

    await handler({} as Request, res);

    expect(statusCode).toBe(200);
    // Traces block reflects the one saved trace.
    expect(body.traces.total).toBe(1);
    expect(body.traces.byKind.query).toBe(1);
    expect(body.traces.byModelChain).toEqual([{ chain: "primary", count: 1, failures: 0 }]);
    // Events block reflects the three real mutations.
    expect(body.events.total).toBe(3);
    expect(body.events.byAction.Creation).toBe(2);
    expect(body.events.byAction.Update).toBe(1);
    expect(body.events.perDay.length).toBe(30);
    expect(body.events.topPaths.find((p: any) => p.path === "/notes/a.md").count).toBe(2);
  });
});
