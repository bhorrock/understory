import { useEffect, useState } from "react";
import { api, type Stats } from "../api";

/** Read-only observability panel: trace + event aggregates. Loads on mount. */
export function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.stats().then(setStats).catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!stats) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;

  const { traces, events } = stats;
  const maxDay = Math.max(1, ...events.perDay.map((d) => d.count));

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Stats</h1>

      {/* Traces */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-400">
          Agent runs <span className="text-zinc-600">({traces.total})</span>
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Queries" value={traces.byKind.query} />
          <Stat label="Mutations" value={traces.byKind.mutation} />
          <Stat label="Chats" value={traces.byKind.chat} />
          <Stat label="Success" value={traces.byOutcome.success} tone="ok" />
          <Stat label="Partial" value={traces.byOutcome.partial} tone="warn" />
          <Stat label="Failed" value={traces.byOutcome.failed} tone="err" />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DistBox title="Steps / run" dist={traces.steps} />
          <DistBox title="Duration (ms)" dist={traces.durationMs} round />
        </div>
        {traces.byModelChain.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                  <th className="px-3 py-2 font-medium">Model chain</th>
                  <th className="px-3 py-2 text-right font-medium">Runs</th>
                  <th className="px-3 py-2 text-right font-medium">Failures</th>
                </tr>
              </thead>
              <tbody>
                {traces.byModelChain.map((c) => (
                  <tr key={c.chain} className="border-b border-zinc-900 last:border-0">
                    <td className="px-3 py-1.5 text-zinc-300">
                      {c.chain || <span className="text-zinc-600">(none)</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{c.count}</td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        c.failures > 0 ? "text-red-300" : "text-zinc-500"
                      }`}
                    >
                      {c.failures}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Events */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-400">
          Mutations <span className="text-zinc-600">({events.total})</span>
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Object.entries(events.byAction).map(([action, count]) => (
            <Stat key={action} label={action} value={count} />
          ))}
        </div>

        {/* 30-day bar strip — pure divs, no chart dependency. */}
        <div className="mt-4">
          <div className="mb-1 text-xs text-zinc-500">Last {events.perDay.length} days</div>
          <div className="flex h-24 items-end gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
            {events.perDay.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: ${d.count}`}
                className="flex-1 rounded-sm bg-cyan-800/70"
                style={{ height: `${(d.count / maxDay) * 100}%`, minHeight: d.count > 0 ? "2px" : "0" }}
              />
            ))}
          </div>
        </div>

        {events.topPaths.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 text-xs text-zinc-500">Most-touched concepts</div>
            <div className="space-y-1">
              {events.topPaths.map((p) => (
                <div
                  key={p.path}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-sm"
                >
                  <span className="truncate text-zinc-300">{p.path}</span>
                  <span className="ml-2 shrink-0 tabular-nums text-zinc-500">{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const TONES: Record<string, string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  err: "text-red-300",
};

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "err" }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${tone ? TONES[tone] : "text-zinc-200"}`}>
        {value}
      </div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function DistBox({
  title,
  dist,
  round,
}: {
  title: string;
  dist: { avg: number; p50: number; p95: number };
  round?: boolean;
}) {
  const fmt = (n: number) => (round ? Math.round(n) : Math.round(n * 10) / 10);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="text-xs text-zinc-500">{title}</div>
      <div className="mt-1 flex gap-4 text-sm text-zinc-300">
        <span>
          <span className="text-zinc-600">avg</span> <span className="tabular-nums">{fmt(dist.avg)}</span>
        </span>
        <span>
          <span className="text-zinc-600">p50</span> <span className="tabular-nums">{fmt(dist.p50)}</span>
        </span>
        <span>
          <span className="text-zinc-600">p95</span> <span className="tabular-nums">{fmt(dist.p95)}</span>
        </span>
      </div>
    </div>
  );
}
