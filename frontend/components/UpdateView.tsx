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
  const [showAllReleases, setShowAllReleases] = useState(false);
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
        <p className="text-sm text-ink-muted">Application updates</p>
        <button
          onClick={loadStatus}
          disabled={loading || applying}
          title="Check for updates"
          aria-label="Check for updates"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-line hover:bg-panel-2 disabled:opacity-40"
        >
          <svg
            viewBox="0 0 24 24"
            className={"h-4 w-4 " + (loading ? "animate-spin" : "")}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {error}
        </p>
      )}

      {status && (
        <>
          <section className="mt-4 rounded-xl border border-line bg-panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-muted">
                  Installed
                </p>
                <p className="mt-1 font-mono text-lg text-ink">
                  {status.current_version}
                </p>
                <p className="mt-1 text-xs text-ink-muted">{status.repo}</p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-ink-muted">
                  Latest
                </p>
                <p className="mt-1 font-mono text-lg text-ink">
                  {status.latest_version ?? "—"}
                </p>
                {status.update_available ? (
                  <span className="mt-1 inline-block rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/60 dark:text-amber-300">
                    Update available
                  </span>
                ) : (
                  <span className="mt-1 inline-block rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-green-900/60 dark:text-green-300">
                    Up to date
                  </span>
                )}
              </div>
            </div>

            {status.detail && (
              <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
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
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {applying || status.in_progress ? (
                  <span className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    </svg>
                    Updating…
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
                    </svg>
                    {status.update_available ? `Update to ${status.latest_version}` : "Update now"}
                  </span>
                )}
              </button>
              {!status.can_apply && (
                <span className="text-xs text-ink-muted">
                  Self-update is only available on the managed LXC deployment.
                </span>
              )}
            </div>
          </section>

          {progress && (
            <section className="mt-4 rounded-xl border border-line bg-app p-4">
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
                <p className="text-sm text-ink">
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
            <h2 className="text-sm font-semibold text-ink">Release history</h2>
            {status.releases.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">
                No releases found for {status.repo}.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {(showAllReleases ? status.releases : status.releases.slice(0, 4)).map((r) => {
                  const isCurrent =
                    r.tag.replace(/^v/i, "") ===
                    status.current_version.replace(/^v/i, "").replace(/-dirty$/, "");
                  const open = expanded === r.tag;
                  return (
                    <li
                      key={r.tag}
                      className="rounded-lg border border-line bg-panel"
                    >
                      <button
                        onClick={() => setExpanded(open ? null : r.tag)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-sm text-ink">
                            {r.name || r.tag}
                          </span>
                          {r.prerelease && (
                            <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-ink-muted">
                              pre-release
                            </span>
                          )}
                          {isCurrent && (
                            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-green-900/60 dark:text-green-300">
                              installed
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-ink-muted">
                          {fmtDate(r.published_at)}
                        </span>
                      </button>
                      {open && (
                        <div className="border-t border-line px-3 py-3">
                          {r.notes ? (
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-ink">
                              {r.notes}
                            </pre>
                          ) : (
                            <p className="text-xs text-ink-muted">
                              No release notes provided.
                            </p>
                          )}
                          {r.url && (
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-2 inline-block text-xs text-accent hover:underline"
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
            {status.releases.length > 4 && (
              <button
                onClick={() => setShowAllReleases((v) => !v)}
                className="mt-3 flex items-center gap-1 text-xs text-accent hover:underline"
              >
                {showAllReleases
                  ? "View less"
                  : `View more (${status.releases.length - 4})`}
                <svg
                  viewBox="0 0 24 24"
                  className={"h-3.5 w-3.5 transition-transform " + (showAllReleases ? "rotate-180" : "")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
