"use client";

// Monitoring: LLM usage + estimated cost dashboard. Self-contained so it can be
// rendered inside a modal on the main page or on the standalone /usage route.

import { useCallback, useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Totals = {
  calls: number;
  billable_calls: number;
  cached_calls: number;
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
};

type DayPoint = { day: string; calls: number; total_tokens: number; cost_usd: number };
type ModelPoint = { model: string; calls: number; total_tokens: number; cost_usd: number };

type Summary = {
  today: Totals;
  last_7_days: Totals;
  all_time: Totals;
  daily: DayPoint[];
  by_model: ModelPoint[];
};

const usd = (n: number) =>
  n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
const num = (n: number) => n.toLocaleString();

function TotalsCard({ title, t }: { title: string; t: Totals }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <p className="text-xs uppercase tracking-wide text-ink-muted">{title}</p>
      <p className="mt-1 text-3xl font-bold text-emerald-600 dark:text-emerald-300">{usd(t.cost_usd)}</p>
      <dl className="mt-3 space-y-1 text-xs text-ink-muted">
        <div className="flex justify-between">
          <dt>Calls</dt>
          <dd className="text-ink">{num(t.calls)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>API (billable)</dt>
          <dd className="text-ink">{num(t.billable_calls)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Cache hits</dt>
          <dd className="text-ink">{num(t.cached_calls)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tokens</dt>
          <dd className="text-ink">{num(t.total_tokens)}</dd>
        </div>
      </dl>
    </div>
  );
}

export default function UsageView() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/usage/summary`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setData(await res.json());
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message}. Is the backend running with a database?`
          : "Failed to load usage.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const maxDayCost = data
    ? Math.max(0.000001, ...data.daily.map((d) => d.cost_usd))
    : 1;

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">LLM usage &amp; estimated cost</p>
        <button
          onClick={load}
          className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel-2"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {error}
        </p>
      )}

      {loading && !data ? (
        <p className="mt-4 text-sm text-ink-muted">Loading…</p>
      ) : data ? (
        <>
          <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TotalsCard title="Today" t={data.today} />
            <TotalsCard title="Last 7 days" t={data.last_7_days} />
            <TotalsCard title="All time" t={data.all_time} />
          </section>

          <p className="mt-3 text-xs text-ink-muted">
            Costs are estimates based on public Gemini list prices and the recorded token
            counts. Cache hits cost $0.
          </p>

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-ink">By model</h2>
            {data.by_model.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">No usage recorded yet.</p>
            ) : (
              <div className="mt-2 overflow-hidden rounded-xl border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-panel text-left text-xs uppercase text-ink-muted">
                    <tr>
                      <th className="px-3 py-2">Model</th>
                      <th className="px-3 py-2 text-right">Calls</th>
                      <th className="px-3 py-2 text-right">Tokens</th>
                      <th className="px-3 py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_model.map((m) => (
                      <tr key={m.model} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-xs text-ink">
                          {m.model}
                        </td>
                        <td className="px-3 py-2 text-right text-ink">
                          {num(m.calls)}
                        </td>
                        <td className="px-3 py-2 text-right text-ink">
                          {num(m.total_tokens)}
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-emerald-600 dark:text-emerald-300">
                          {usd(m.cost_usd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-ink">
              Daily (last 30 days)
            </h2>
            {data.daily.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">No usage recorded yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {data.daily.map((d) => (
                  <li key={d.day} className="flex items-center gap-3 text-xs">
                    <span className="w-24 shrink-0 font-mono text-ink-muted">
                      {d.day}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-panel">
                      <div
                        className="h-full rounded bg-accent"
                        style={{ width: `${(d.cost_usd / maxDayCost) * 100}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right text-ink-muted">
                      {num(d.calls)} ×
                    </span>
                    <span className="w-16 shrink-0 text-right font-medium text-emerald-600 dark:text-emerald-300">
                      {usd(d.cost_usd)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
