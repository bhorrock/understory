import { promises as fs } from "node:fs";
import path from "node:path";
import type { Bundle } from "./bundle.js";
import { parseLegacyLog } from "./logger.js";
import type { LogAction } from "./types.js";

/** Filename of the append-only event stream, the system of record for history. */
const EVENTS_FILE = ".events.jsonl";

/**
 * One knowledge-base mutation, recorded append-only in `<bundle>/.events.jsonl`
 * (one JSON object per line). This is the system of record; log.md is a derived
 * projection. Readers tolerate unknown keys and skip corrupt lines.
 */
export interface KnowledgeEvent {
  /** ISO-8601 timestamp of the mutation. */
  ts: string;
  action: LogAction;
  /** Bundle-relative path of the affected concept, "" when unknown (backfill). */
  path: string;
  /** Past-tense log summary, as shown in log.md. */
  summary: string;
  /** Path of a concept this change supersedes, when applicable. */
  supersedes?: string;
  /** Trace that produced this mutation, when driven by the agent. */
  traceId?: string;
  /** Model chain (primary → fallback labels) that produced this mutation. */
  modelChain?: string[];
}

export interface EventFilter {
  pathContains?: string;
  action?: LogAction;
  /** Inclusive lower bound on `ts` (ISO string, lexicographic compare). */
  since?: string;
  /** Inclusive upper bound on `ts` (ISO string, lexicographic compare). */
  until?: string;
  /** Newest-first cap. Defaults to 50. */
  limit?: number;
}

function eventsPath(bundle: Bundle): string {
  return path.join(bundle.root, EVENTS_FILE);
}

/** Append one event to `<bundle>/.events.jsonl`. O(1) — never rewrites the file. */
export async function appendEvent(bundle: Bundle, ev: KnowledgeEvent): Promise<void> {
  await fs.appendFile(eventsPath(bundle), JSON.stringify(ev) + "\n", "utf-8");
}

/**
 * Read events newest-first, applying optional filters. The file is append-only
 * (oldest-first); corrupt or blank lines are skipped, unknown keys tolerated.
 */
export async function readEvents(
  bundle: Bundle,
  filter: EventFilter = {}
): Promise<KnowledgeEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(eventsPath(bundle), "utf-8");
  } catch {
    return [];
  }
  const events: KnowledgeEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip corrupt lines — the stream stays readable through partial writes.
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ev = parsed as KnowledgeEvent;
    if (typeof ev.ts !== "string" || typeof ev.action !== "string") continue;
    if (filter.pathContains && !(ev.path ?? "").includes(filter.pathContains)) continue;
    if (filter.action && ev.action !== filter.action) continue;
    if (filter.since && ev.ts < filter.since) continue;
    if (filter.until && ev.ts > filter.until) continue;
    events.push(ev);
  }
  events.reverse();
  const limit = filter.limit ?? 50;
  return events.slice(0, limit);
}

/**
 * One-time synthesis of the event stream from a legacy log.md. No-op when the
 * events file already exists (never double-counts). Backfilled events carry the
 * log date at midnight UTC and no path (the legacy log records none).
 */
export async function backfillEventsFromLog(bundle: Bundle): Promise<void> {
  try {
    await fs.access(eventsPath(bundle));
    return; // Events already exist; nothing to backfill.
  } catch {
    // No events file yet — synthesize from the legacy log if one exists.
  }
  let logRaw: string;
  try {
    logRaw = await fs.readFile(path.join(bundle.root, "log.md"), "utf-8");
  } catch {
    return; // No legacy log either.
  }
  const entries = parseLegacyLog(logRaw); // newest-first
  // The stream is oldest-first; append in chronological order.
  for (const entry of [...entries].reverse()) {
    await appendEvent(bundle, {
      ts: `${entry.date}T00:00:00.000Z`,
      action: entry.action,
      path: "",
      summary: entry.summary,
    });
  }
}
