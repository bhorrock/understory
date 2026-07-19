import express, { type Router } from "express";
import {
  TraceStore,
  type KnowledgeBase,
  type KnowledgeEvent,
  type QueryTrace,
} from "@understory/core";

/** Aggregate statistics over the trace log and the event stream. */
export interface StatsPayload {
  traces: TraceStats;
  events: EventStats;
}

export interface Distribution {
  avg: number;
  p50: number;
  p95: number;
}

export interface ModelChainStat {
  /** Model labels joined with "→" (empty string when no chain recorded). */
  chain: string;
  count: number;
  failures: number;
}

export interface TraceStats {
  total: number;
  byKind: { query: number; mutation: number; chat: number };
  byOutcome: { success: number; partial: number; failed: number };
  steps: Distribution;
  durationMs: Distribution;
  byModelChain: ModelChainStat[];
}

export interface EventStats {
  total: number;
  byAction: Record<string, number>;
  /** One bucket per day for the last N days, oldest-first. */
  perDay: { date: string; count: number }[];
  /** Ten most-touched concept paths, descending by count. */
  topPaths: { path: string; count: number }[];
}

/** Percentile of a sorted numeric sample (nearest-rank). Empty → 0, never NaN. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

/**
 * Pure aggregation over a set of traces. Exported for tests — no I/O, no clock.
 */
export function aggregateTraces(traces: QueryTrace[]): TraceStats {
  const byKind = { query: 0, mutation: 0, chat: 0 };
  const byOutcome = { success: 0, partial: 0, failed: 0 };
  const chains = new Map<string, { count: number; failures: number }>();
  const stepCounts: number[] = [];
  const durations: number[] = [];

  for (const t of traces) {
    if (t.kind in byKind) byKind[t.kind] += 1;
    if (t.outcome in byOutcome) byOutcome[t.outcome] += 1;
    stepCounts.push(t.steps?.length ?? 0);
    durations.push(t.durationMs ?? 0);

    const chain = (t.modelChain ?? []).join("→");
    const entry = chains.get(chain) ?? { count: 0, failures: 0 };
    entry.count += 1;
    if (t.outcome === "failed") entry.failures += 1;
    chains.set(chain, entry);
  }

  const byModelChain: ModelChainStat[] = [...chains.entries()]
    .map(([chain, { count, failures }]) => ({ chain, count, failures }))
    .sort((a, b) => b.count - a.count || (a.chain < b.chain ? -1 : 1));

  return {
    total: traces.length,
    byKind,
    byOutcome,
    steps: distribution(stepCounts),
    durationMs: distribution(durations),
    byModelChain,
  };
}

/** UTC calendar day (YYYY-MM-DD) of an ISO timestamp. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Pure aggregation over events. `now` is injectable so the perDay window is
 * deterministic in tests. The window is the `days` UTC calendar days ending on
 * (and including) `now`'s day; events outside it are excluded from perDay only
 * (byAction/topPaths/total count every event passed in).
 */
export function aggregateEvents(
  events: KnowledgeEvent[],
  days = 30,
  now: Date = new Date()
): EventStats {
  const byAction: Record<string, number> = {};
  const pathCounts = new Map<string, number>();
  const dayCounts = new Map<string, number>();

  for (const ev of events) {
    byAction[ev.action] = (byAction[ev.action] ?? 0) + 1;
    if (ev.path) pathCounts.set(ev.path, (pathCounts.get(ev.path) ?? 0) + 1);
    if (typeof ev.ts === "string" && ev.ts) {
      dayCounts.set(dayKey(ev.ts), (dayCounts.get(dayKey(ev.ts)) ?? 0) + 1);
    }
  }

  // Day axis: `days` UTC buckets ending on now's day (inclusive), oldest-first.
  const perDay: { date: string; count: number }[] = [];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    perDay.push({ date: key, count: dayCounts.get(key) ?? 0 });
  }

  const topPaths = [...pathCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))
    .slice(0, 10);

  return { total: events.length, byAction, perDay, topPaths };
}

/** Compute the full stats payload from live sources (traces + events). */
export async function computeStats(kb: KnowledgeBase): Promise<StatsPayload> {
  const traces = await new TraceStore(kb.bundle.root).list();
  const events = await kb.readEvents({ limit: 10_000 });
  return {
    traces: aggregateTraces(traces),
    events: aggregateEvents(events),
  };
}

/** Deterministic observability API — no LLM involved, no tokens spent. */
export function statsRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  router.get("/stats", async (_req, res) => {
    res.json(await computeStats(kb));
  });

  return router;
}
