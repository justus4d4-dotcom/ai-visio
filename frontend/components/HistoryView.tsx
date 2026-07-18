"use client";

// History browser: list, view, and delete persisted question/answer records.
// Self-contained (fetches its own data) so it can be rendered inside a modal on the
// main page or on the standalone /history route.

import { useCallback, useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type HistoryItem = {
  id: string;
  question_text: string;
  question_type: string;
  answer_letters: string[];
  answer_text: string | null;
  full_answer: string | null;
  confidence: number | null;
  provider_label: string | null;
  tokens_used: number | null;
  has_image: boolean;
  status: string;
  error_type: string | null;
  error_detail: string | null;
  elapsed_ms: number | null;
  created_at: string;
};

export default function HistoryView() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Filter: show everything, or only failed requests (timeouts / errors).
  const [failuresOnly, setFailuresOnly] = useState(false);

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

  const isFailure = (it: HistoryItem) => it.status && it.status !== "success";
  const failureCount = items.filter(isFailure).length;
  const visible = failuresOnly ? items.filter(isFailure) : items;

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <p className="text-sm text-ink-muted">
            {visible.length} {failuresOnly ? "failed" : "logged"}{" "}
            {visible.length === 1 ? "request" : "requests"}
          </p>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={failuresOnly}
              onChange={(e) => setFailuresOnly(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            Failures only
            {failureCount > 0 && (
              <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-700 dark:bg-red-900/60 dark:text-red-200">
                {failureCount}
              </span>
            )}
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel-2"
          >
            Refresh
          </button>
          <button
            onClick={clearAll}
            disabled={items.length === 0}
            className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-40 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/60"
          >
            Clear all
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-ink-muted">Loading…</p>
      ) : visible.length === 0 && !error ? (
        <p className="mt-4 text-sm text-ink-muted">
          {failuresOnly
            ? "No failed requests logged. 🎉"
            : "No history yet. Interpret a frame and it will appear here."}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {visible.map((it) => {
            const conf =
              it.confidence != null ? Math.round(it.confidence * 100) : null;
            const failed = isFailure(it);
            return (
              <li
                key={it.id}
                className={
                  "rounded-xl border bg-panel p-4 " +
                  (failed ? "border-red-500/40 dark:border-red-900/70" : "border-line")
                }
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
                          "rounded-lg border border-line object-cover transition-all " +
                          (open === it.id ? "max-h-80 w-auto" : "h-16 w-16")
                        }
                      />
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      {failed ? (
                        <span
                          className={
                            "rounded px-2 py-0.5 text-sm font-semibold " +
                            (it.status === "timeout"
                              ? "bg-amber-500/15 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200"
                              : "bg-red-500/15 text-red-700 dark:bg-red-900/60 dark:text-red-200")
                          }
                        >
                          {it.status === "timeout" ? "Timeout" : "Error"}
                        </span>
                      ) : (
                        <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-300">
                          {it.answer_letters.join(" ") || "—"}
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-ink-muted">
                        {new Date(it.created_at).toLocaleString()}
                      </span>
                    </div>

                    {failed ? (
                      <p className="mt-1 text-sm text-red-600 dark:text-red-300">
                        {it.error_detail || it.error_type || "Request failed."}
                      </p>
                    ) : (
                      <>
                        {it.answer_text && (
                          <p className="mt-1 text-sm text-ink">
                            {it.answer_text}
                          </p>
                        )}
                        {it.full_answer && it.full_answer !== it.answer_text && (
                          <p className="mt-1 whitespace-pre-wrap text-xs text-ink-muted">
                            {it.full_answer}
                          </p>
                        )}
                      </>
                    )}

                    <p className="mt-1 line-clamp-2 text-xs text-ink-muted">
                      {it.question_text}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                      <span className="rounded bg-panel-2 px-1.5 py-0.5">
                        {it.question_type}
                      </span>
                      {conf != null && !failed && (
                        <span className="rounded bg-panel-2 px-1.5 py-0.5">
                          {conf}% confidence
                        </span>
                      )}
                      {it.provider_label && (
                        <span className="rounded bg-panel-2 px-1.5 py-0.5">
                          {it.provider_label}
                        </span>
                      )}
                      {it.elapsed_ms != null && (
                        <span className="rounded bg-panel-2 px-1.5 py-0.5">
                          {(it.elapsed_ms / 1000).toFixed(1)}s
                        </span>
                      )}
                      {it.tokens_used != null && (
                        <span className="rounded bg-panel-2 px-1.5 py-0.5">
                          {it.tokens_used} tokens
                        </span>
                      )}
                      <button
                        onClick={() => deleteOne(it.id)}
                        className="ml-auto rounded border border-line px-2 py-0.5 hover:bg-panel-2"
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
    </div>
  );
}
