"use client";

// Monitoring: LLM usage + estimated cost dashboard.
// Single-user app, so this reflects all solves recorded in Postgres.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

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
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{title}</p>
      <p className="mt-1 text-3xl font-bold text-green-400">{usd(t.cost_usd)}</p>
      <dl className="mt-3 space-y-1 text-xs text-neutral-400">
        <div className="flex justify-between">
          <dt>Calls</dt>
          <dd className="text-neutral-200">{num(t.calls)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>API (billable)</dt>
          <dd className="text-neutral-200">{num(t.billable_calls)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Cache hits</dt>
          <dd className="text-neutral-200">{num(t.cached_calls)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tokens</dt>
          <dd className="text-neutral-200">{num(t.total_tokens)}</dd>
        </div>
      </dl>
    </div>
  );
}

export default function UsagePage() {
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
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Monitoring</h1>
          <p className="text-sm text-neutral-400">LLM usage &amp; estimated cost</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Back
          </Link>
          <button
            onClick={load}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <p className="mt-6 rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {loading && !data ? (
        <p className="mt-6 text-sm text-neutral-500">Loading…</p>
      ) : data ? (
        <>
          <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TotalsCard title="Today" t={data.today} />
            <TotalsCard title="Last 7 days" t={data.last_7_days} />
            <TotalsCard title="All time" t={data.all_time} />
          </section>

          <p className="mt-3 text-xs text-neutral-500">
            Costs are estimates based on public Gemini list prices and the recorded token
            counts. Cache hits cost $0.
          </p>

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-neutral-300">By model</h2>
            {data.by_model.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-500">No usage recorded yet.</p>
            ) : (
              <div className="mt-2 overflow-hidden rounded-xl border border-neutral-800">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-900 text-left text-xs uppercase text-neutral-500">
                    <tr>
                      <th className="px-3 py-2">Model</th>
                      <th className="px-3 py-2 text-right">Calls</th>
                      <th className="px-3 py-2 text-right">Tokens</th>
                      <th className="px-3 py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_model.map((m) => (
                      <tr key={m.model} className="border-t border-neutral-800">
                        <td className="px-3 py-2 font-mono text-xs text-neutral-200">
                          {m.model}
                        </td>
                        <td className="px-3 py-2 text-right text-neutral-300">
                          {num(m.calls)}
                        </td>
                        <td className="px-3 py-2 text-right text-neutral-300">
                          {num(m.total_tokens)}
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-green-400">
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
            <h2 className="text-sm font-semibold text-neutral-300">
              Daily (last 30 days)
            </h2>
            {data.daily.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-500">No usage recorded yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {data.daily.map((d) => (
                  <li key={d.day} className="flex items-center gap-3 text-xs">
                    <span className="w-24 shrink-0 font-mono text-neutral-400">
                      {d.day}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-neutral-900">
                      <div
                        className="h-full rounded bg-indigo-600"
                        style={{ width: `${(d.cost_usd / maxDayCost) * 100}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right text-neutral-400">
                      {num(d.calls)} ×
                    </span>
                    <span className="w-16 shrink-0 text-right font-medium text-green-400">
                      {usd(d.cost_usd)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
