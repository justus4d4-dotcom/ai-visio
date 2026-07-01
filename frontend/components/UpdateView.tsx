"use client";

// "Update" section for the Settings modal: shows the deployed version vs the latest
// GitHub release, release notes + history, and a button that triggers the backend
// self-update (deploy/update.sh) and streams its progress log.

import { useCallback, useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Release = {
  tag: string;
  name: string | null;
  notes: string | null;
  published_at: string | null;
  url: string | null;
  prerelease: boolean;
};

type Status = {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  releases: Release[];
  repo: string;
  can_apply: boolean;
  in_progress: boolean;
  detail: string | null;
};

type Progress = {
  state: "idle" | "running" | "success" | "failed";
  target: string | null;
  log: string;
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";

export default function UpdateView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/updates/status`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data: Status = await res.json();
      setStatus(data);
      // Expand the newest release's notes by default.
      setExpanded((cur) => cur ?? data.releases[0]?.tag ?? null);
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message}. Is the backend running?`
          : "Failed to load update status.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Poll the update log while an update is running (or was already in progress).
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/api/updates/progress`, { cache: "no-store" });
        // The backend restarts mid-update, so failures here are expected — keep polling.
        if (!res.ok) return;
        const data: Progress = await res.json();
        setProgress(data);
        if (data.state === "success" || data.state === "failed") {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setApplying(false);
          // Refresh the version once the dust settles.
          if (data.state === "success") setTimeout(loadStatus, 1500);
        }
      } catch {
        /* backend likely restarting — ignore and keep polling */
      }
    };
    tick();
    pollRef.current = setInterval(tick, 2000);
  }, [loadStatus]);

  // If the server says an update is already running (e.g. reopened the panel), attach.
  useEffect(() => {
    if (status?.in_progress) {
      setApplying(true);
      startPolling();
    }
  }, [status?.in_progress, startPolling]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function applyUpdate(target?: string) {
    if (
      !confirm(
        `Update the running application to ${target ?? status?.latest_version ?? "the latest release"}?\n\n` +
          "The backend and frontend will restart and be briefly unavailable.",
      )
    )
      return;
    setApplying(true);
    setError(null);
    setProgress({ state: "running", target: target ?? null, log: "" });
    try {
      const res = await fetch(`${API_URL}/api/updates/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: target ?? null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail ?? `Failed (${res.status})`);
      startPolling();
    } catch (e) {
      setApplying(false);
      setError(e instanceof Error ? e.message : "Could not start the update.");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-neutral-400">Application updates</p>
        <button
          onClick={loadStatus}
          disabled={loading || applying}
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40"
        >
          {loading ? "Checking…" : "Check again"}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {status && (
        <>
          <section className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-neutral-500">
                  Installed
                </p>
                <p className="mt-1 font-mono text-lg text-neutral-100">
                  {status.current_version}
                </p>
                <p className="mt-1 text-xs text-neutral-500">{status.repo}</p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-neutral-500">
                  Latest
                </p>
                <p className="mt-1 font-mono text-lg text-neutral-100">
                  {status.latest_version ?? "—"}
                </p>
                {status.update_available ? (
                  <span className="mt-1 inline-block rounded bg-amber-900/70 px-2 py-0.5 text-xs font-medium text-amber-300">
                    Update available
                  </span>
                ) : (
                  <span className="mt-1 inline-block rounded bg-green-900/60 px-2 py-0.5 text-xs font-medium text-green-300">
                    Up to date
                  </span>
                )}
              </div>
            </div>

            {status.detail && (
              <p className="mt-3 rounded-lg border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-300">
                {status.detail}
              </p>
            )}

            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => applyUpdate()}
                disabled={
                  !status.can_apply ||
                  !status.update_available ||
                  applying ||
                  status.in_progress
                }
                title={
                  !status.can_apply
                    ? "Updating is disabled on this server (not a managed deployment)."
                    : !status.update_available
                      ? "Already on the latest release."
                      : "Fetch the latest release, migrate, rebuild and restart."
                }
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {applying || status.in_progress
                  ? "Updating…"
                  : status.update_available
                    ? `Update to ${status.latest_version}`
                    : "Update now"}
              </button>
              {!status.can_apply && (
                <span className="text-xs text-neutral-500">
                  Self-update is only available on the managed LXC deployment.
                </span>
              )}
            </div>
          </section>

          {progress && (
            <section className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950 p-4">
              <div className="flex items-center gap-2">
                <span
                  className={
                    "inline-block h-2 w-2 rounded-full " +
                    (progress.state === "running"
                      ? "bg-amber-400 animate-pulse"
                      : progress.state === "success"
                        ? "bg-green-500"
                        : progress.state === "failed"
                          ? "bg-red-500"
                          : "bg-neutral-600")
                  }
                />
                <p className="text-sm text-neutral-300">
                  {progress.state === "running"
                    ? `Updating${progress.target ? ` to ${progress.target}` : ""}… the app will restart.`
                    : progress.state === "success"
                      ? "Update complete."
                      : progress.state === "failed"
                        ? "Update failed — see the log below."
                        : "Idle"}
                </p>
              </div>
              {progress.log && (
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-black p-3 text-[11px] leading-relaxed text-neutral-400">
                  {progress.log}
                </pre>
              )}
            </section>
          )}

          <section className="mt-6">
            <h2 className="text-sm font-semibold text-neutral-300">Release history</h2>
            {status.releases.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-500">
                No releases found for {status.repo}.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {status.releases.map((r) => {
                  const isCurrent =
                    r.tag.replace(/^v/i, "") ===
                    status.current_version.replace(/^v/i, "").replace(/-dirty$/, "");
                  const open = expanded === r.tag;
                  return (
                    <li
                      key={r.tag}
                      className="rounded-lg border border-neutral-800 bg-neutral-900"
                    >
                      <button
                        onClick={() => setExpanded(open ? null : r.tag)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-sm text-neutral-100">
                            {r.name || r.tag}
                          </span>
                          {r.prerelease && (
                            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                              pre-release
                            </span>
                          )}
                          {isCurrent && (
                            <span className="rounded bg-green-900/60 px-1.5 py-0.5 text-[10px] text-green-300">
                              installed
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-neutral-500">
                          {fmtDate(r.published_at)}
                        </span>
                      </button>
                      {open && (
                        <div className="border-t border-neutral-800 px-3 py-3">
                          {r.notes ? (
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-300">
                              {r.notes}
                            </pre>
                          ) : (
                            <p className="text-xs text-neutral-500">
                              No release notes provided.
                            </p>
                          )}
                          {r.url && (
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-2 inline-block text-xs text-indigo-400 hover:underline"
                            >
                              View on GitHub →
                            </a>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
