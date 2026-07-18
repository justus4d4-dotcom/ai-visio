"use client";

// Read-only tablet display (Feature 1).
//
// Open this page on an iPad (or any browser) to show the FULL LLM answer — the complete
// free-form response, not just the A/B/C/D letters shown on the tiny ESP32 screen. It is
// display-only: it never captures or solves. It simply mirrors the latest answer the
// solving browser/agent pushed to the in-memory remote bridge, plus a live feed of recent
// requests (including failures) from the request log. It sits behind the same Google
// sign-in as the rest of the app (AuthGate in the root layout).

import { useEffect, useMemo, useState } from "react";
import type { SolveResult } from "@/lib/settings";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type RemoteState = {
  status: string; // idle | requested | solving | done | error
  answer_id: string | null;
  answer: SolveResult | null;
};

type FeedItem = {
  id: string;
  question_type: string;
  answer_letters: string[];
  answer_text: string | null;
  full_answer: string | null;
  status: string;
  error_type: string | null;
  error_detail: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  idle: "Waiting for a question…",
  requested: "Triggered — capturing…",
  solving: "Thinking…",
  done: "Answer",
  error: "Last request failed",
};

export default function DisplayPage() {
  const [state, setState] = useState<RemoteState | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [online, setOnline] = useState(true);

  // Poll the remote bridge for the latest answer/status (all displays share it).
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/api/remote/answer`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data: RemoteState = await res.json();
        if (!stopped) {
          setState(data);
          setOnline(true);
        }
      } catch {
        if (!stopped) setOnline(false);
      }
    };
    tick();
    const id = setInterval(tick, 1200);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  // Poll the request log for the live feed (successes + failures).
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/api/history?limit=20`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        if (!stopped) setFeed(await res.json());
      } catch {
        /* ignore transient errors */
      }
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const answer = state?.answer ?? null;
  const status = state?.status ?? "idle";
  const solving = status === "solving" || status === "requested";
  const conf = answer ? Math.round(answer.confidence * 100) : null;

  const bodyText = useMemo(() => {
    if (!answer) return "";
    return answer.full_answer?.trim() || answer.answer_text?.trim() || "";
  }, [answer]);

  return (
    <main className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-wide text-neutral-300">
            AI VISIO — Display
          </span>
          <span
            className={
              "inline-block h-2.5 w-2.5 rounded-full " +
              (!online
                ? "bg-neutral-600"
                : solving
                  ? "bg-amber-400 animate-pulse"
                  : status === "error"
                    ? "bg-red-500"
                    : "bg-green-500")
            }
          />
          <span className="text-xs text-neutral-500">
            {!online ? "Reconnecting…" : STATUS_LABEL[status] ?? status}
          </span>
        </div>
        {answer && (
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <span className="rounded bg-neutral-800 px-2 py-0.5">
              {answer.question_type}
            </span>
            {conf != null && (
              <span className="rounded bg-neutral-800 px-2 py-0.5">{conf}%</span>
            )}
          </div>
        )}
      </header>

      <div className="grid flex-1 gap-6 p-6 lg:grid-cols-[2fr_1fr]">
        {/* MAIN: the full answer. */}
        <section className="flex min-h-0 flex-col rounded-2xl border border-neutral-800 bg-neutral-900 p-8">
          {solving ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <div className="flex items-end gap-2">
                <span className="h-4 w-4 animate-bounce rounded-full bg-indigo-400 [animation-delay:-0.3s]" />
                <span className="h-4 w-4 animate-bounce rounded-full bg-indigo-400 [animation-delay:-0.15s]" />
                <span className="h-4 w-4 animate-bounce rounded-full bg-indigo-400" />
              </div>
              <p className="animate-pulse text-lg font-medium text-indigo-300">
                Thinking…
              </p>
            </div>
          ) : !answer ? (
            <div className="flex flex-1 items-center justify-center text-center text-lg text-neutral-500">
              Waiting for the first answer. Trigger a solve from the ESP32 or the app.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {answer.answer_letters.length > 0 && (
                <div className="mb-4 text-6xl font-bold tracking-wide text-green-400">
                  {answer.answer_letters.join("  ")}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                <p className="whitespace-pre-wrap text-3xl leading-relaxed text-neutral-100">
                  {bodyText || "—"}
                </p>
                {answer.question_text && (
                  <p className="mt-6 border-t border-neutral-800 pt-4 text-base text-neutral-500">
                    {answer.question_text}
                  </p>
                )}
              </div>
              {conf != null && (
                <div className="mt-6">
                  <div className="h-2 w-full overflow-hidden rounded bg-neutral-800">
                    <div
                      className="h-full bg-green-500"
                      style={{ width: `${conf}%` }}
                    />
                  </div>
                  <p className="mt-1 text-sm text-neutral-500">
                    Confidence {conf}% · {answer.model}
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        {/* SIDE: live request/log feed (successes + failures). */}
        <aside className="flex min-h-0 flex-col rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-300">Recent requests</h2>
          <ul className="min-h-0 flex-1 space-y-2 overflow-auto">
            {feed.length === 0 ? (
              <li className="text-sm text-neutral-500">No requests yet.</li>
            ) : (
              feed.map((it) => {
                const failed = it.status && it.status !== "success";
                return (
                  <li
                    key={it.id}
                    className={
                      "rounded-lg border bg-neutral-950 px-3 py-2 " +
                      (failed ? "border-red-900/70" : "border-neutral-800")
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      {failed ? (
                        <span
                          className={
                            "rounded px-1.5 py-0.5 text-xs font-semibold " +
                            (it.status === "timeout"
                              ? "bg-amber-900/70 text-amber-200"
                              : "bg-red-900/70 text-red-200")
                          }
                        >
                          {it.status === "timeout" ? "Timeout" : "Error"}
                        </span>
                      ) : (
                        <span className="text-base font-bold text-green-400">
                          {it.answer_letters.join(" ") || it.question_type}
                        </span>
                      )}
                      <span className="shrink-0 text-[11px] text-neutral-600">
                        {new Date(it.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-neutral-400">
                      {failed
                        ? it.error_detail || it.error_type || "Request failed."
                        : it.answer_text || it.full_answer || "—"}
                    </p>
                  </li>
                );
              })
            )}
          </ul>
        </aside>
      </div>
    </main>
  );
}
