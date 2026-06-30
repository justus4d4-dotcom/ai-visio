"use client";

// M7 History: browse, view, and delete persisted question/answer records.
// Single-user app, so this is the global history stored in Postgres.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type HistoryItem = {
  id: string;
  question_text: string;
  question_type: string;
  answer_letters: string[];
  answer_text: string | null;
  confidence: number | null;
  provider_label: string | null;
  tokens_used: number | null;
  has_image: boolean;
  created_at: string;
};

export default function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/history?limit=200`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setItems(await res.json());
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message}. Is the backend running with a database?`
          : "Failed to load history.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function deleteOne(id: string) {
    await fetch(`${API_URL}/api/history/${id}`, { method: "DELETE" });
    setItems((xs) => xs.filter((x) => x.id !== id));
  }

  async function clearAll() {
    if (!confirm("Delete all history? This cannot be undone.")) return;
    await fetch(`${API_URL}/api/history`, { method: "DELETE" });
    setItems([]);
  }

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">History</h1>
          <p className="text-sm text-neutral-400">
            {items.length} saved {items.length === 1 ? "result" : "results"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Back
          </Link>
          <button
            onClick={clearAll}
            disabled={items.length === 0}
            className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/60 disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
      </header>

      {error && (
        <p className="mt-6 rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-6 text-sm text-neutral-500">Loading…</p>
      ) : items.length === 0 && !error ? (
        <p className="mt-6 text-sm text-neutral-500">
          No history yet. Interpret a frame on the{" "}
          <Link href="/" className="text-indigo-400 underline">
            main page
          </Link>{" "}
          and it will appear here.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((it) => {
            const conf =
              it.confidence != null ? Math.round(it.confidence * 100) : null;
            return (
              <li
                key={it.id}
                className="rounded-xl border border-neutral-800 bg-neutral-900 p-4"
              >
                <div className="flex gap-4">
                  {it.has_image && (
                    <button
                      onClick={() => setOpen(open === it.id ? null : it.id)}
                      className="shrink-0"
                      title="Toggle image"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${API_URL}/api/history/${it.id}/image`}
                        alt="captured frame"
                        className={
                          "rounded-lg border border-neutral-800 object-cover transition-all " +
                          (open === it.id ? "max-h-80 w-auto" : "h-16 w-16")
                        }
                      />
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-2xl font-bold text-green-400">
                        {it.answer_letters.join(" ") || "—"}
                      </span>
                      <span className="shrink-0 text-xs text-neutral-500">
                        {new Date(it.created_at).toLocaleString()}
                      </span>
                    </div>
                    {it.answer_text && (
                      <p className="mt-1 text-sm text-neutral-200">{it.answer_text}</p>
                    )}
                    <p className="mt-1 line-clamp-2 text-xs text-neutral-500">
                      {it.question_text}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                        {it.question_type}
                      </span>
                      {conf != null && (
                        <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                          {conf}% confidence
                        </span>
                      )}
                      {it.provider_label && (
                        <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                          {it.provider_label}
                        </span>
                      )}
                      {it.tokens_used != null && (
                        <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                          {it.tokens_used} tokens
                        </span>
                      )}
                      <button
                        onClick={() => deleteOne(it.id)}
                        className="ml-auto rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
